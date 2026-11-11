// ASTER ADL emergency handling (plan 2.3b, simulated only): evidence from the
// push stream and the force-order history, reduce-only market batches under the
// notional cap, the L054 update-time guard, bounded recovery of batches without
// an answer, the halt conditions and the manual restart, takeover, and the
// boundaries: control injected, auto-reduce off, account change while open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ContractError } from '../src/contracts.ts';
import { createExecutor, type Budgets } from '../src/executor.ts';
import { createExecutorServer } from '../src/http.ts';
import { MIGRATIONS, openStore, sqlHash } from '../src/store.ts';
import type { AccountWriterPort } from '../src/account-control.ts';
import { planReductions } from '../src/adl.ts';
import { SimulatedAsterTrading } from '../src/sim-aster-trading.ts';
import { SIM_TRANSFER_PAIR } from '../src/simulation.ts';
import { ADL_ROLLBACK_SQL, SESSION, createHarness, type Harness } from './harness.ts';

const { id: PAIR, long: LONG, short: SHORT } = SIM_TRANSFER_PAIR;
const SYMBOL = 'BTCUSDT';
const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
/** Short real-time call limits, so a hung simulated call costs the test 50 ms. */
const QUICK: Partial<Budgets> = { adlReadTimeoutMs: 50, adlOrderTimeoutMs: 50 };

async function withAdl(run: (h: Harness) => Promise<void>, budgets: Partial<Budgets> = {}, control?: NonNullable<Parameters<typeof createHarness>[0]>['control']) {
  const h = createHarness({ budgets: { ...QUICK, ...budgets }, control });
  try {
    h.ex.registerTransferPair(SIM_TRANSFER_PAIR);
    await h.ex.tick();
    await run(h);
  } finally { h.asterTrading.releaseHung(); h.aster.releaseHung(); h.dispose(); }
}
/** Moves the clock in steps, running one pass after each. */
async function run(h: Harness, ms: number, step = 1_000) {
  for (let left = ms; left > 0; left -= step) { h.advance(Math.min(step, left)); await h.ex.tick(); }
}
const pairView = (h: Harness) => h.ex.adlPairs().find(item => item.pairId === PAIR)!;
const current = (h: Harness) => pairView(h).incident;
const recent = (h: Harness) => h.ex.recentAdlIncidents(10);
const amount = (h: Harness, account: string, side: 'LONG' | 'SHORT') => h.asterTrading.position(account, SYMBOL, side);
const balanced = (h: Harness) => Number(amount(h, LONG, 'LONG')) + Number(amount(h, SHORT, 'SHORT')) === 0;
const events = (h: Harness, type: string) => (h.store.db.prepare('SELECT json FROM events WHERE type = ? ORDER BY seq').all(type) as { json: string }[]).map(row => JSON.parse(row.json) as Record<string, unknown>);
const config = (h: Harness, change: { autoReduce?: boolean; batchNotional?: string }, requestId = randomUUID()) =>
  h.ex.setAdlConfig({ pairId: PAIR, requestId, autoReduce: change.autoReduce ?? true, batchNotional: change.batchNotional ?? '1000' }, SESSION);
const takeover = (h: Harness) => { h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true); };
/** Runs passes until the pair has no open incident, or fails after `limit` passes. */
async function untilClosed(h: Harness, limit = 30, step = 1_000) {
  for (let i = 0; i < limit && current(h); i++) await run(h, step, step);
  assert.equal(current(h), null, '事件应已结束');
}

test('ADL：推送证据开启事件，按单批金额上限分批只减仓市价，多空总量一致后自动结束并标记证据已处理', () => withAdl(async h => {
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  const open = current(h)!;
  assert.equal(open.status, 'active');
  assert.deepEqual(open.symbols, [SYMBOL]);
  // 1000 USDT ÷ 60000 = 0.01666…, floored to the 0.001 step: never enlarged, never above the cap.
  assert.deepEqual(open.batches.map(batch => [batch.side, batch.orderSide, batch.positionSide, batch.quantity, batch.state]), [['short', 'buy', 'SHORT', '0.016', 'done']]);
  await untilClosed(h);
  const [done] = recent(h);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.batches.map(batch => batch.quantity).reverse(), ['0.016', '0.004']);
  assert.deepEqual(done.residuals, []);
  assert.equal(done.progress[SYMBOL].status, 'balanced');
  assert.ok(balanced(h));
  assert.equal(h.asterTrading.calls.place, 2);
  // Evidence is handled: further passes open nothing new.
  await run(h, 120_000, 10_000);
  assert.equal(recent(h).length, 1);
  assert.equal(h.asterTrading.calls.place, 2);
  assert.equal(done.evidence[0].handledQuantity, '0.02');
}));

test('ADL：只有强平历史（无推送）时按 60 秒节奏扫描发现；满页按时间窗二分不漏行；安装前的旧 ADL 不追溯', () => withAdl(async h => {
  // Created before the pair was installed: never traced back, neither from the history nor from a push.
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.001', { at: h.clock.now - 5_000 });
  h.asterTrading.setPosition(LONG, SYMBOL, 'LONG', '0.05', h.clock.now - 5_000);
  (h.asterTrading.capabilities as { historyPageLimit: number }).historyPageLimit = 2;
  h.advance(1_000);
  for (let i = 0; i < 3; i++) { h.advance(1_000); h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.001', { push: false }); }
  await h.ex.tick();
  assert.equal(current(h), null, '扫描间隔未到，不读历史');
  await run(h, 60_000, 5_000);
  assert.ok(recent(h).length, '应从历史发现 ADL');
  await untilClosed(h);
  await run(h, 20_000);
  // Rows found in later windows may join the incident or open a follow-up one; together they are exactly the three.
  const evidence = recent(h).flatMap(item => item.evidence);
  assert.deepEqual(new Set(evidence.map(item => item.orderId)).size, 3);
  assert.ok(evidence.every(item => item.sources.includes('history') && !item.sources.includes('push')));
  assert.ok(h.asterTrading.calls.history > 4, '满页时应细分时间窗');
  assert.equal(pairView(h).scans!.long.note, null);
  assert.equal(pairView(h).scans!.long.pendingWindows, 0);
  assert.ok(balanced(h));
}));

test('ADL：推送行无法解析时丢弃并记事件；历史行无法解析时整次扫描失败、保留时间窗，恢复后补读', () => withAdl(async h => {
  h.asterTrading.pushRaw(LONG, { clientOrderId: 'adl_autoclose', symbol: 'bad symbol' });
  await h.ex.tick();
  assert.equal(events(h, 'adl-push-dropped').length, 1);
  assert.equal(current(h), null);
  h.asterTrading.inject({ operation: 'history', mode: 'malformed', times: 2, accountId: LONG });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.002', { push: false });
  await run(h, 61_000, 61_000);
  assert.match(pairView(h).scans!.long.note ?? '', /保留待查时间窗/);
  assert.equal(current(h), null);
  await run(h, 30_000, 10_000);
  assert.equal(pairView(h).scans!.long.note, null);
  assert.ok(recent(h).length >= 1);
  await untilClosed(h);
  assert.ok(balanced(h));
}));

test('ADL：同一 ADL 订单前后回报不一致时证据冲突，事件受阻不下单；有未结束事件时拒绝更换配对账户', () => withAdl(async h => {
  const orderId = h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  h.asterTrading.adlUpdate(LONG, orderId, { quantity: '0.03', status: 'partially-filled' });
  await h.ex.tick();
  const open = current(h)!;
  assert.equal(open.status, 'blocked');
  assert.match(open.reason ?? '', /证据冲突/);
  assert.equal(h.asterTrading.calls.place, 0);
  assert.throws(() => h.ex.registerTransferPair({ ...SIM_TRANSFER_PAIR, long: `0x${'d'.repeat(40)}` }), code('adl_incident_open'));
  // Re-registering the same accounts is not a change and stays allowed.
  h.ex.registerTransferPair(SIM_TRANSFER_PAIR);
  await run(h, 60_000, 10_000);
  assert.equal(h.asterTrading.calls.place, 0);
}));

test('ADL：残差小于最小下单量记为完成并注明数量与方向；单批金额上限买不到一手时保持受阻，调高后继续', () => withAdl(async h => {
  h.asterTrading.setRule(SYMBOL, { minQuantity: '0.01' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.005');
  await h.ex.tick();
  const [done] = recent(h);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.residuals, [{ symbol: SYMBOL, quantity: '0.005', direction: 'short' }]);
  assert.match(done.reason ?? '', /残差/);
  assert.equal(h.asterTrading.calls.place, 0);

  h.asterTrading.setRule(SYMBOL, { minQuantity: '0.001' });
  config(h, { batchNotional: '50' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.002');
  await run(h, 1_000);
  const blocked = current(h)!;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.progress[SYMBOL].status, 'blocked');
  assert.match(blocked.progress[SYMBOL].reason ?? '', /单批金额上限 50 USDT 不足以满足最小数量 0\.001/);
  await run(h, 30_000, 10_000);
  assert.equal(h.asterTrading.calls.place, 0);
  config(h, { batchNotional: '1000' });
  await untilClosed(h);
  // Planned from the scene: the earlier residual is reduced together with the new difference.
  assert.ok(balanced(h));
}));

test('ADL：持仓更新时间未覆盖 ADL 成交或上一批成交（L054）时不下单，现场同步后继续', () => withAdl(async h => {
  h.advance(1_000);
  h.asterTrading.freezePositions(LONG);
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  assert.match(current(h)!.reason ?? '', /持仓更新时间尚未覆盖 ADL 成交/);
  assert.equal(h.asterTrading.calls.place, 0);
  h.asterTrading.freezePositions(LONG, false);
  h.asterTrading.freezePositions(SHORT);
  await run(h, 10_000, 10_000);
  assert.equal(h.asterTrading.calls.place, 1);
  await run(h, 1_000);
  assert.match(current(h)!.reason ?? '', /减仓成交尚未反映/);
  await run(h, 20_000, 10_000);
  assert.equal(h.asterTrading.calls.place, 1, '旧现场下不发第二批');
  h.asterTrading.freezePositions(SHORT, false);
  await untilClosed(h, 30, 10_000);
  assert.ok(balanced(h));
}));

test('ADL：事件合约有未完成挂单时等待；受阻时间不计入 1800 秒处理时限', () => withAdl(async h => {
  h.asterTrading.addOpenOrder(SHORT, SYMBOL, 'manual-order');
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  assert.match(current(h)!.reason ?? '', /未完成挂单/);
  await run(h, 3_600_000, 10_000);
  assert.equal(h.asterTrading.calls.place, 0);
  assert.equal(current(h)!.status, 'blocked');
  h.asterTrading.clearOpenOrders(SHORT);
  await untilClosed(h, 10, 10_000);
  const [done] = recent(h);
  assert.ok(done.activeMs < 60_000, `处理时长只计 active：${done.activeMs}`);
  assert.ok(balanced(h));
}, { adlMaxActiveMs: 120_000 }));

test('ADL：回报丢失的批次只按原客户订单号查询并接受迟到回报，不重发', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'lost-response' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  assert.equal(current(h)!.batches[0].state, 'unknown');
  await run(h, 1_000);
  assert.equal(recent(h)[0].batches.at(-1)!.state, 'done');
  await untilClosed(h);
  const clientIds = recent(h)[0].batches.map(batch => batch.clientOrderId);
  assert.equal(new Set(clientIds).size, clientIds.length);
  assert.equal(h.asterTrading.arrived.place, clientIds.length);
  assert.ok(balanced(h));
}));

test('ADL：始终无回执的批次查询 3 次并观察 120 秒后按新现场继续；平衡后观察 10 分钟期满自动关闭，原单从不重发', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'lost-request' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  const first = current(h)!.batches[0];
  assert.equal(first.state, 'unknown');
  await run(h, 60_000, 2_000);
  assert.equal(h.asterTrading.calls.query, 3, '查询次数有界');
  assert.equal(h.asterTrading.calls.place, 1, '观察期内不发新批');
  await run(h, 70_000, 2_000);
  const watching = current(h)!;
  assert.equal(watching.status, 'watching');
  assert.ok(balanced(h));
  assert.equal(watching.batches.find(batch => batch.id === first.id)!.state, 'unknown-verified');
  assert.ok(watching.watchUntil! > h.clock.now);
  assert.ok(!h.asterTrading.orders(SHORT).some(order => order.clientOrderId === first.clientOrderId), '原单从未到达');
  await run(h, 600_000, 30_000);
  assert.equal(current(h), null);
  const [closed] = recent(h);
  assert.equal(closed.status, 'completed');
  assert.match(closed.reason ?? '', /观察期满，自动关闭/);
  assert.equal(closed.batches.find(batch => batch.id === first.id)!.state, 'unknown-closed');
  assert.equal(h.asterTrading.calls.place, 3);
}));

test('ADL：观察期内出现新的净差时关闭原事件并开启新事件，结果未知的原单随新事件继续观察', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'lost-request' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  const first = current(h)!.batches[0];
  await run(h, 130_000, 2_000);
  const parent = current(h)!;
  assert.equal(parent.status, 'watching');
  h.asterTrading.setPosition(LONG, SYMBOL, 'LONG', '0.04');
  await run(h, 10_000, 10_000);
  const child = current(h)!;
  assert.notEqual(child.id, parent.id);
  assert.equal(child.parentId, parent.id);
  const closedParent = recent(h).find(item => item.id === parent.id)!;
  assert.equal(closedParent.status, 'completed');
  assert.match(closedParent.reason ?? '', /新的净差/);
  await run(h, 10_000);
  // The unknown batch of the parent still keeps the successor watching.
  const watching = current(h);
  assert.equal(watching?.status, 'watching');
  assert.equal(watching?.id, child.id);
  const stored = JSON.parse((h.store.db.prepare('SELECT json FROM adl_batches WHERE id = ?').get(first.id) as { json: string }).json) as { state: string };
  assert.equal(stored.state, 'unknown-verified');
  assert.ok(balanced(h));
}));

test('ADL：交易所挂着未成交的批次 10 秒后撤单，撤单回报终态后才规划下一批', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'rest' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  assert.equal(current(h)!.batches[0].state, 'open');
  await run(h, 8_000, 2_000);
  assert.equal(h.asterTrading.arrived.cancel, 0);
  await run(h, 4_000, 2_000);
  assert.equal(h.asterTrading.arrived.cancel, 1);
  const canceled = current(h)!.batches.at(-1)!;
  assert.deepEqual([canceled.state, canceled.orderStatus, canceled.cancelRequested], ['done', 'canceled', true]);
  await untilClosed(h);
  assert.ok(balanced(h));
}));

test('ADL：撤单结果未知而挂单仍在时每 10 秒再撤，最多 3 次；仍在挂单即停止自动减仓等人工处理，挂单结束后可重新开始', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'rest' });
  h.asterTrading.inject({ operation: 'cancel', mode: 'lost-request', times: 3 });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  // Halted only after a query finds the order still working at least 10 s after the last cancel (slow pace: 30 s).
  let spent = 0;
  for (; h.asterTrading.calls.cancel < 3 && spent < 60_000; spent += 2_000) await run(h, 2_000);
  assert.equal(h.asterTrading.calls.cancel, 3);
  assert.equal(current(h)!.status, 'active', '最后一次撤单后先查询确认仍在挂单才停止');
  await run(h, 80_000 - spent, 2_000);
  assert.deepEqual([h.asterTrading.calls.cancel, h.asterTrading.arrived.cancel], [3, 0]);
  const halted = current(h)!;
  assert.equal(halted.status, 'halted');
  assert.match(halted.haltReason ?? '', /撤单 3 次后仍在挂单/);
  await run(h, 60_000, 10_000);
  assert.equal(h.asterTrading.calls.cancel, 3, '达到上限后不再撤单');
  assert.equal(h.asterTrading.calls.place, 1);
  // The order ends at the venue; the slow query settles the batch, then a person restarts.
  const [resting] = h.asterTrading.orders(SHORT);
  h.asterTrading.fill(SHORT, resting.clientOrderId);
  await run(h, 40_000, 10_000);
  assert.equal(current(h)!.batches.at(-1)!.state, 'done');
  h.ex.restartAdl({ incidentId: halted.id, requestId: randomUUID() }, SESSION);
  await untilClosed(h);
  assert.ok(balanced(h));
}));

test('ADL：挂单部分成交后被撤、回报时间晚于成交时，持仓在已知未成交时刻之后更新且过观察期即视为已反映（L054），不长期受阻', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'rest' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  await run(h, 9_000);
  assert.equal(h.asterTrading.arrived.cancel, 0);
  // Filled between the fast queries and the cancel, so the first report that shows the fill is the cancel itself.
  const [resting] = h.asterTrading.orders(SHORT);
  h.asterTrading.fill(SHORT, resting.clientOrderId, '0.006');
  await run(h, 2_000);
  assert.equal(h.asterTrading.arrived.cancel, 1);
  const batch = current(h)!.batches.at(-1)!;
  assert.deepEqual([batch.state, batch.orderStatus, batch.filledQuantity], ['done', 'canceled', '0.006']);
  await run(h, 30_000, 10_000);
  assert.match(current(h)!.reason ?? '', /减仓成交尚未反映/);
  assert.equal(h.asterTrading.calls.place, 1);
  await untilClosed(h, 30, 10_000);
  assert.ok(balanced(h));
}));

test('ADL：结果未知的批次第一份回报即带成交且晚于持仓更新时，以规划时的持仓时间为已知未成交时刻，过观察期即视为已反映（L054）', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'lost-request' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  const [batch] = current(h)!.batches;
  assert.equal(batch.state, 'unknown');
  // The late order arrives, partly fills, and is canceled on the venue before any query of it succeeds.
  h.advance(1_000);
  h.asterTrading.arriveLate(batch.clientOrderId);
  h.asterTrading.fill(SHORT, batch.clientOrderId, '0.006');
  h.advance(1_000);
  h.asterTrading.cancelOnVenue(SHORT, batch.clientOrderId);
  await run(h, 30_000, 5_000);
  const held = current(h)!;
  assert.deepEqual([held.batches[0].orderStatus, held.batches[0].filledQuantity], ['canceled', '0.006']);
  assert.match(held.reason ?? '', /减仓成交尚未反映/);
  assert.equal(h.asterTrading.calls.place, 1);
  await untilClosed(h, 30, 10_000);
  assert.ok(balanced(h));
}));

test('ADL：历史时间窗满页且无法细分时保留该窗并轮转，之后的时间仍按节奏扫描发现新 ADL', () => withAdl(async h => {
  (h.asterTrading.capabilities as { historyPageLimit: number }).historyPageLimit = 1;
  h.advance(1_000);
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.001', { push: false });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.001', { push: false });
  await run(h, 120_000, 5_000);
  assert.ok(pairView(h).scans!.long.pendingWindows >= 1, '无法细分的时间窗保留待查');
  const later = h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.001', { push: false });
  await run(h, 300_000, 5_000);
  const found = (h.store.db.prepare('SELECT json FROM adl_evidence').all() as { json: string }[]).map(row => JSON.parse(row.json) as { orderId: string });
  assert.ok(found.some(item => item.orderId === later), '卡住的时间窗之后的 ADL 仍被发现');
  assert.ok(pairView(h).scans!.long.pendingWindows >= 1);
}));

test('ADL：观察期内原单迟到并挂单、撤单 3 次仍在时继续观察并注明需人工撤单，期满也不关闭；挂单结束后照常收尾', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'lost-request' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  const first = current(h)!.batches[0];
  await run(h, 130_000, 2_000);
  const watching = current(h)!;
  assert.equal(watching.status, 'watching');
  await run(h, watching.watchUntil! - h.clock.now - 60_000, 30_000);
  h.asterTrading.arriveLate(first.clientOrderId);
  h.asterTrading.inject({ operation: 'cancel', mode: 'lost-request', times: 3 });
  await run(h, 150_000, 5_000);
  assert.ok(h.clock.now > watching.watchUntil!);
  const still = current(h)!;
  assert.equal(still.id, watching.id, '挂单未结清时观察不结束');
  assert.equal(still.status, 'watching');
  assert.match(still.reason ?? '', /撤单 3 次后仍在挂单/);
  assert.equal(still.batches.find(batch => batch.id === first.id)!.state, 'open');
  h.asterTrading.fill(SHORT, first.clientOrderId);
  await untilClosed(h, 60, 10_000);
  assert.ok(balanced(h));
}));

test('ADL：没有未结束事件时残留的未结清批次照常核对并撤单，结清前拒绝更换配对账户', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'rest' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  assert.equal(current(h)!.batches[0].state, 'open');
  // A leftover the normal flow no longer produces: the incident ended while its batch still works.
  h.store.db.prepare("UPDATE adl_incidents SET final = 1, status = 'completed', json = json_set(json, '$.status', 'completed')").run();
  h.store.db.prepare("UPDATE adl_evidence SET pending = 0, json = json_set(json, '$.handledQuantity', json_extract(json, '$.filledQuantity'))").run();
  assert.equal(current(h), null);
  assert.throws(() => h.ex.registerTransferPair({ ...SIM_TRANSFER_PAIR, long: `0x${'d'.repeat(40)}` }), code('adl_incident_open'));
  await run(h, 12_000, 2_000);
  assert.equal(h.asterTrading.arrived.cancel, 1);
  assert.equal((h.store.db.prepare('SELECT COUNT(*) AS n FROM adl_batches WHERE settled = 0').get() as { n: number }).n, 0);
}));

test('ADL：最后一批被拒绝即停止自动减仓；人工重新开始后重置计数并继续；只有已停止的事件可以重新开始，请求编号幂等', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'reject' });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  await run(h, 30_000, 10_000);
  const halted = current(h)!;
  assert.equal(halted.status, 'halted');
  assert.match(halted.haltReason ?? '', /被交易所拒绝/);
  assert.equal(h.asterTrading.calls.place, 1);
  const requestId = randomUUID();
  const restarted = h.ex.restartAdl({ incidentId: halted.id, requestId }, SESSION);
  assert.equal(restarted.restarts, 1);
  assert.equal(restarted.batchesSinceRestart, 0);
  // A replay returns the same result; the id cannot carry another incident.
  assert.equal(h.ex.restartAdl({ incidentId: halted.id, requestId }, SESSION).restarts, 1);
  assert.throws(() => h.ex.restartAdl({ incidentId: randomUUID(), requestId }, SESSION), code('request_reused'));
  assert.throws(() => h.ex.restartAdl({ incidentId: halted.id, requestId: randomUUID() }, SESSION), code('adl_not_halted'));
  await untilClosed(h);
  assert.ok(balanced(h));
  assert.equal(events(h, 'adl-incident-restarted').length, 1);
}));

test('ADL：连续三批零成交停止；连续未能发出达到上限也停止（L084）', async () => {
  await withAdl(async h => {
    h.asterTrading.inject({ operation: 'place', mode: 'zero-fill', times: 3 });
    h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
    await run(h, 10_000);
    const halted = current(h)!;
    assert.equal(halted.status, 'halted');
    assert.match(halted.haltReason ?? '', /连续三批未成交/);
    assert.equal(h.asterTrading.calls.place, 3);
  });
  await withAdl(async h => {
    h.asterTrading.inject({ operation: 'place', mode: 'not-sent', times: 100 });
    h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
    await run(h, 60_000);
    const halted = current(h)!;
    assert.equal(halted.status, 'halted');
    assert.match(halted.haltReason ?? '', /连续 5 批未能发出/);
    assert.equal(h.asterTrading.calls.place, 5);
    assert.equal(h.asterTrading.arrived.place, 0);
  }, { adlNotSentLimit: 5 });
});

test('ADL：处理时限只计 active 时间，超过即停止并保留现场', () => withAdl(async h => {
  h.asterTrading.inject({ operation: 'place', mode: 'partial', fraction: '0.001', times: 100 });
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await run(h, 60_000, 1_000);
  const halted = current(h)!;
  assert.equal(halted.status, 'halted');
  assert.match(halted.haltReason ?? '', /处理时限或批次数上限/);
  assert.ok(!balanced(h));
}, { adlMaxActiveMs: 10_000 }));

test('ADL：落盘后发送前中断的批次记为未发送；发送中被接管的批次记为结果未知并按原客户订单号核对，不重发', () => withAdl(async h => {
  // prepared: the write marking it sending fails once.
  const tx = h.store.tx;
  let armed = true;
  h.store.tx = (operation => {
    if (armed && h.store.db.prepare("SELECT 1 FROM adl_batches WHERE state = 'prepared'").get()) { armed = false; throw new Error('模拟磁盘写入失败'); }
    return tx(operation);
  }) as typeof tx;
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
  await h.ex.tick();
  h.store.tx = tx;
  assert.equal(h.asterTrading.calls.place, 0);
  await run(h, 10_000, 10_000);
  const notSent = recent(h)[0].batches.find(batch => batch.state === 'not-sent');
  assert.ok(notSent, '中断的已落盘批次记为未发送');
  assert.match(notSent.note ?? '', /传输未调用/);

  // sending: the call hangs while another instance takes over.
  h.asterTrading.inject({ operation: 'place', mode: 'hang' });
  const before = h.asterTrading.calls.place;
  const pending = h.ex.tick();
  while (h.asterTrading.calls.place === before) await new Promise(resolve => setImmediate(resolve));
  takeover(h);
  h.asterTrading.releaseHung();
  await pending.catch(() => undefined);
  const recovered = current(h)!.batches.find(batch => batch.recovered)!;
  assert.equal(recovered.state, 'unknown');
  assert.match(recovered.note ?? '', /不重发/);
  await untilClosed(h, 400, 2_000);
  const all = recent(h)[0].batches.map(batch => batch.clientOrderId);
  assert.equal(new Set(all).size, all.length);
  assert.ok(!h.asterTrading.orders(SHORT).some(order => order.clientOrderId === recovered.clientOrderId));
  assert.ok(balanced(h));
}, { adlOrderTimeoutMs: 5_000 }));

test('ADL：注入共享写者登记时只核对现场、不发送减仓单', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-adl-control-'));
  const { createAccountWriter } = await import(new URL('../../../server/execution/account-writer.mjs', import.meta.url).href) as { createAccountWriter(options: Record<string, unknown>): AccountWriterPort & { close(): void } };
  const writers: (AccountWriterPort & { close(): void })[] = [];
  try {
    await withAdl(async h => {
      h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
      await run(h, 60_000, 10_000);
      const open = current(h)!;
      assert.equal(open.status, 'blocked');
      assert.match(open.reason ?? '', /共享写者登记/);
      assert.equal(h.asterTrading.calls.place, 0);
    }, {}, clock => {
      const writer = createAccountWriter({ databasePath: join(dir, 'execution-control.sqlite'), moduleId: 'platform', runtimeId: randomUUID(), pid: 42_000 + writers.length, now: () => clock.now, processAlive: () => true });
      writers.push(writer);
      return { writer, environment: 'testnet' };
    });
  } finally { for (const writer of writers) writer.close(); }
});

test('ADL：无登记时留下的挂单批次，在注入共享写者登记后接管也不撤单', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-adl-control-'));
  const { createAccountWriter } = await import(new URL('../../../server/execution/account-writer.mjs', import.meta.url).href) as { createAccountWriter(options: Record<string, unknown>): AccountWriterPort & { close(): void } };
  const writers: (AccountWriterPort & { close(): void })[] = [];
  let instances = 0;
  try {
    await withAdl(async h => {
      h.asterTrading.inject({ operation: 'place', mode: 'rest' });
      h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
      await h.ex.tick();
      assert.equal(current(h)!.batches[0].state, 'open');
      takeover(h);
      await run(h, 60_000, 5_000);
      assert.equal(h.asterTrading.calls.cancel, 0);
      assert.equal(h.asterTrading.calls.place, 1);
    }, {}, clock => {
      if (instances++ === 0) return undefined;
      const writer = createAccountWriter({ databasePath: join(dir, 'execution-control.sqlite'), moduleId: 'platform', runtimeId: randomUUID(), pid: 43_000 + writers.length, now: () => clock.now, processAlive: () => true });
      writers.push(writer);
      return { writer, environment: 'testnet' };
    });
  } finally { for (const writer of writers) writer.close(); }
});

test('ADL：关闭自动减仓时只核对，两侧被手工平衡后事件自动完成；无交易权限时受阻不下单', async () => {
  await withAdl(async h => {
    config(h, { autoReduce: false });
    h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
    await h.ex.tick();
    const open = current(h)!;
    assert.match(open.reason ?? '', /自动减仓已关闭/);
    assert.equal(open.progress[SYMBOL].status, 'manual');
    h.asterTrading.setPosition(SHORT, SYMBOL, 'SHORT', '-0.03');
    await untilClosed(h, 5, 10_000);
    assert.equal(h.asterTrading.calls.place, 0);
  });
  await withAdl(async h => {
    h.asterTrading.setCanTrade(SHORT, false);
    h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
    await run(h, 30_000, 10_000);
    assert.match(current(h)!.reason ?? '', /没有交易权限/);
    assert.equal(h.asterTrading.calls.place, 0);
  });
});

test('ADL：设置请求编号幂等，同编号不同内容被拒绝；设置值越界被拒绝', () => withAdl(async h => {
  const requestId = randomUUID();
  assert.equal(config(h, { batchNotional: '500' }, requestId).config.batchNotional, '500');
  config(h, { batchNotional: '500' }, requestId);
  assert.throws(() => config(h, { batchNotional: '600' }, requestId), code('request_reused'));
  assert.throws(() => config(h, { batchNotional: '0.5' }), code('invalid_value'));
  assert.throws(() => h.ex.setAdlConfig({ pairId: PAIR, requestId: randomUUID(), autoReduce: true, batchNotional: '10', extra: 1 }, SESSION), ContractError);
  assert.equal(events(h, 'adl-config-changed').length, 1);
}));

test('规划：多出方向按持仓量从大到小选择，数量取差额、持仓、市价上限与金额上限的最小值后按步长向下取整', () => {
  const rule = { symbol: SYMBOL, quantityStep: '0.001', minQuantity: '0.001', maxMarketQuantity: '0.01', tradable: true, quoteAsset: 'USDT' };
  const position = (quantity: string, direction: 'long' | 'short', positionSide: 'LONG' | 'SHORT') => ({ symbol: SYMBOL, positionSide, direction, quantity, markPrice: '60000', updateTime: 1 });
  const { plan, progress } = planReductions({ long: [position('0.05', 'long', 'LONG')], short: [position('0.02', 'short', 'SHORT'), position('0.01', 'long', 'LONG')] }, [SYMBOL], new Map([[SYMBOL, rule]]), '1000');
  assert.deepEqual(plan && [plan.side, plan.positionSide, plan.direction, plan.quantity, plan.excessBefore], ['long', 'LONG', 'long', '0.01', '0.04']);
  assert.equal(progress[SYMBOL].status, 'reducing');
  const missing = planReductions({ long: [position('0.05', 'long', 'LONG')], short: [] }, [SYMBOL], new Map([[SYMBOL, '读取失败']]), '1000');
  assert.deepEqual([missing.plan, missing.progress[SYMBOL].status], [null, 'blocked']);
});

test('HTTP：ADL 设置与重新开始走会话和请求标记；状态接口带 ADL 配对与最近事件，账户打码', () => withAdl(async h => {
  const server = createExecutorServer({ executor: h.ex, accessToken: 'adl-access-token-0001', session: SESSION });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/login?token=adl-access-token-0001`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-pa-executor': '1' }) =>
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post(`/api/adl/pairs/${PAIR}/config`, { requestId: randomUUID(), autoReduce: true, batchNotional: '800' }, {})).status, 403);
    const saved = await post(`/api/adl/pairs/${PAIR}/config`, { requestId: randomUUID(), autoReduce: true, batchNotional: '800' });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { config: { batchNotional: string } }).config.batchNotional, '800');
    assert.equal((await post(`/api/adl/pairs/${PAIR}/config`, { requestId: randomUUID(), autoReduce: true, batchNotional: '800', pairId: 'x' })).status, 400);
    assert.equal((await post('/api/adl/pairs/unknown/config', { requestId: randomUUID(), autoReduce: true, batchNotional: '800' })).status, 404);
    assert.equal((await post(`/api/adl/incidents/${randomUUID()}/restart`, { requestId: randomUUID() })).status, 404);
    h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.02');
    await h.ex.tick();
    const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { adl: { pairs: { long: string; incident: { id: string } | null }[]; recent: unknown[] } };
    assert.equal(state.adl.pairs[0].long, `***${LONG.slice(-4)}`);
    assert.ok(state.adl.pairs[0].incident);
    assert.ok(!JSON.stringify(state.adl).includes(LONG));
    const conflict = await post(`/api/adl/incidents/${state.adl.pairs[0].incident!.id}/restart`, { requestId: randomUUID() });
    assert.equal(conflict.status, 409);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('存储：已有 v3 库升级到 v4 只新增 ADL 四张表与索引，原有数据保留；回滚语句退回 v3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-adl-upgrade-'));
  const file = join(dir, 'v3.sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sql_sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, 3)) {
    old.exec(migration.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, 0)').run(migration.version, migration.name, sqlHash(migration.sql));
  }
  old.prepare("INSERT INTO transfer_pairs VALUES ('sim-pair', 0, 1, 1, '{}')").run();
  old.prepare("INSERT INTO commands VALUES ('r0', 'transfer-enable', 'd', 's', 'sim-pair', 1)").run();
  const names = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const before = names(old);
  old.close();
  const store = openStore(file);
  try {
    assert.equal(store.schemaVersion(), 4);
    assert.deepEqual(names(store.db).filter(name => !before.includes(name)), ['adl_batches', 'adl_batches_incident', 'adl_batches_open', 'adl_batches_pair', 'adl_evidence', 'adl_evidence_pair',
      'adl_evidence_pending', 'adl_incidents', 'adl_incidents_created', 'adl_incidents_open', 'adl_incidents_pair', 'adl_pairs']);
    store.db.prepare("INSERT INTO adl_pairs VALUES ('sim-pair', 1, 1, '{}')").run();
    store.db.prepare("INSERT INTO adl_incidents VALUES ('i1', 'sim-pair', 'completed', 1, 1, 1, '{}')").run();
    store.db.prepare("INSERT INTO adl_batches VALUES ('b1', 'i1', 'sim-pair', 'adl-x', 'done', 1, 1, 1, '{}')").run();
    store.db.prepare("INSERT INTO commands VALUES ('r1', 'adl-config', 'd', 's', 'sim-pair', 1), ('r2', 'adl-restart', 'd', 's', 'i1', 1)").run();
    store.db.exec(ADL_ROLLBACK_SQL);
    assert.equal(store.schemaVersion(), 3);
    assert.deepEqual(names(store.db), before);
    assert.deepEqual((store.db.prepare('SELECT request_id FROM commands').all() as { request_id: string }[]).map(row => row.request_id), ['r0']);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM transfer_pairs').get() as { n: number }).n, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('边界：ADL 连接器不是模拟传输，或环境不是模拟时拒绝启动；历史分页上限无效时拒绝', () => withAdl(async h => {
  const live = new SimulatedAsterTrading(() => h.clock.now);
  (live.capabilities as { transport: string }).transport = 'live';
  assert.throws(() => createExecutor({ store: h.store, connectors: [], adl: live }), code('live_transport_refused'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [], environment: 'mainnet', adl: h.asterTrading }), code('live_transport_refused'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [], adl: new SimulatedAsterTrading(() => h.clock.now, { historyPageLimit: 1 }) }), code('budget'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [], adl: h.asterTrading, budgets: { adlMaxBatches: 0 } }), code('budget'));
}));

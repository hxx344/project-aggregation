// ASTER margin-balance transfers: the venue takes no client id, so a send
// without an answer is never resent; it is labeled from both accounts' receipts
// once the signed request has expired and settled whatever the read shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { ContractError } from '../src/contracts.ts';
import { DEFAULT_BUDGETS, WriterLostError, createExecutor, type Budgets } from '../src/executor.ts';
import { MIGRATIONS, openStore, sqlHash } from '../src/store.ts';
import { SimulatedAster } from '../src/sim-aster.ts';
import type { AccountWriterPort } from '../src/account-control.ts';
import type { PairRecord } from '../src/transfer.ts';
import { SIM_TRANSFER_PAIR } from '../src/simulation.ts';
import { ADL_ROLLBACK_SQL, SESSION, bindAccounts, createHarness, openIntent, previewAndConfirm, settle, type Harness } from './harness.ts';

const { id: PAIR, mainAccountId: MAIN, long: LONG, short: SHORT } = SIM_TRANSFER_PAIR;
const THIRD = `0x${'d'.repeat(40)}`, FOURTH = `0x${'e'.repeat(40)}`, OTHER_MAIN = `0x${'f'.repeat(40)}`;
const READY_MS = 180_000, DEFER_MS = 300_000, REFRESH_MS = 300_000;
const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;

async function withHarness(run: (h: Harness) => Promise<void>, options?: Parameters<typeof createHarness>[0]) {
  const h = createHarness(options);
  try { await run(h); } finally { h.aster.releaseHung(); h.dispose(); }
}
const flip = (h: Harness, enabled: boolean, pairId: string = PAIR) => h.ex.setTransferEnabled({ pairId, enabled, requestId: randomUUID() }, SESSION);
async function start(h: Harness, config: Record<string, unknown> = {}, pair: Record<string, unknown> = {}) {
  const view = h.ex.registerTransferPair({ ...SIM_TRANSFER_PAIR, ...pair, config });
  await flip(h, true, view.id);
}
const pairOf = (h: Harness, id: string = PAIR) => h.ex.transferPairs().find(pair => pair.id === id)!;
const stored = (h: Harness, id: string = PAIR) => JSON.parse((h.store.db.prepare('SELECT json FROM transfer_pairs WHERE id = ?').get(id) as { json: string }).json) as PairRecord;
const used = (h: Harness, id: string = PAIR) => stored(h, id).usedReceipts.map(item => item.tranId);
/** Oldest first. */
const transfers = (h: Harness) => h.ex.recentTransfers(100).reverse();
const last = (h: Harness) => h.ex.recentTransfers(1)[0];
/** Moves the clock in steps, running one pass after each. */
async function run(h: Harness, ms: number, step = 5_000) {
  for (let left = ms; left > 0; left -= step) { h.advance(Math.min(step, left)); await h.ex.tick(); }
}
const takeover = (h: Harness) => { h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true); };
/** A harness whose executors get a shared account-writer registry once enable() was called; each restart gets its own writer. */
async function controlledHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-transfer-control-'));
  const { createAccountWriter } = await import(new URL('../../../server/execution/account-writer.mjs', import.meta.url).href) as { createAccountWriter(options: Record<string, unknown>): AccountWriterPort & { close(): void } };
  const writers: (AccountWriterPort & { close(): void })[] = [];
  let controlled = false;
  const h = createHarness({
    control: clock => {
      if (!controlled) return undefined;
      const writer = createAccountWriter({ databasePath: join(dir, 'execution-control.sqlite'), moduleId: 'platform', runtimeId: randomUUID(), pid: 41_000 + writers.length, now: () => clock.now, processAlive: () => true });
      writers.push(writer);
      return { writer, environment: 'testnet' };
    },
  });
  return {
    h, writers,
    enable() { controlled = true; },
    dispose() {
      h.aster.releaseHung(); h.dispose();
      for (const writer of writers) try { writer.close(); } catch { /* a retired writer may refuse */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error(`等待超时：${label}`);
}
/** One send that ends unknown, with the given fault; returns the transfer as first seen. */
async function sendUnknown(h: Harness, mode: 'lost-response' | 'lost-request' | 'one-side' | 'delayed-history' | 'ack-not-success', extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  h.aster.inject({ operation: 'transfer', mode, ...extra });
  await start(h, config);
  await h.ex.tick();
  const transfer = last(h);
  assert.equal(transfer.state, 'unknown');
  return transfer;
}

test('划转：多侧富余时把差额一半划给空侧，回执后重读两侧余额才记为已执行；平衡后不再划转', () => withHarness(async h => {
  await start(h);
  assert.equal(pairOf(h).enabled, true);
  await h.ex.tick();
  const transfer = last(h);
  assert.deepEqual([transfer.state, transfer.basis, transfer.sourceSide, transfer.destinationSide, transfer.amount, transfer.asset], ['confirmed', 'acknowledged', 'long', 'short', '100', 'USD1']);
  assert.equal(transfer.receipt, h.aster.ledger[0].tranId);
  assert.ok(transfer.balancesRefreshedAt! >= transfer.ackAt!);
  assert.deepEqual(h.aster.ledger.map(item => [item.source, item.destination, item.amount]), [[LONG, SHORT, '100']]);
  const pair = pairOf(h);
  assert.deepEqual([pair.balances!.long.available, pair.balances!.short.available, pair.current], ['500', '500', null]);
  assert.equal(pair.cooldownUntil, transfer.sentAt! + 30_000);
  assert.doesNotMatch(JSON.stringify(h.ex.transferPairs()), new RegExp(`${LONG}|${SHORT}|${MAIN}`), '视图不暴露完整地址');
  await run(h, 60_000);
  assert.equal(h.aster.calls.transfer, 1);
  assert.match(pairOf(h).note ?? '', /未超过划转门槛/);
}));

test('划转：回执不带交易编号也在刷新余额后记为已执行，并注明缺少编号', () => withHarness(async h => {
  h.aster.inject({ operation: 'transfer', mode: 'ack-without-tranId' });
  await start(h);
  await h.ex.tick();
  const transfer = last(h);
  assert.deepEqual([transfer.state, transfer.basis, transfer.tranId, transfer.receipt, transfer.labelNote], ['confirmed', 'acknowledged', null, null, '回执未带交易编号']);
  assert.deepEqual(used(h), []);
}));

test('划转规划：门槛须严格超过；一半取整后低于最小额、现金保留、可划上限或单次上限不足时不划或少划；空侧富余时反向', async () => {
  const once = async (setup: (h: Harness) => void, config: Record<string, unknown> = {}) => {
    let result: { sent: string[] | null; note: string | null } = { sent: null, note: null };
    await withHarness(async h => {
      setup(h);
      await start(h, config);
      await h.ex.tick();
      const entry = h.aster.ledger[0];
      result = { sent: entry ? [entry.source, entry.amount] : null, note: pairOf(h).note };
    });
    return result;
  };
  const long = (available: string, more: { equity?: string; maxWithdraw?: string } = {}) => (h: Harness) => h.aster.setBalance(LONG, { available, equity: available, ...more });
  let result = await once(long('410'));
  assert.equal(result.sent, null); assert.match(result.note!, /未超过划转门槛 10 USD1/);
  assert.deepEqual((await once(long('410.00000002'))).sent, [LONG, '5.00000001']);
  result = await once(long('401.99999999'), { threshold: '0' });
  assert.equal(result.sent, null); assert.match(result.note!, /取整为 0\.99999999 USD1，低于最小划转额/);
  assert.deepEqual((await once(long('402'), { threshold: '0' })).sent, [LONG, '1']);
  assert.deepEqual((await once(h => { h.aster.setBalance(LONG, { available: '400', equity: '400' }); h.aster.setBalance(SHORT, { available: '600', equity: '600' }); })).sent, [SHORT, '100']);
  // Cash reserve: 5% of the source's equity stays there.
  result = await once(long('600', { equity: '12000' }));
  assert.equal(result.sent, null); assert.match(result.note!, /现金保留 600 USD1/);
  assert.deepEqual((await once(long('600', { equity: '10400' }))).sent, [LONG, '80']);
  assert.deepEqual((await once(long('600', { equity: '-50' }))).sent, [LONG, '100'], '负权益按零计保留');
  result = await once(long('600', { maxWithdraw: '0.5' }));
  assert.equal(result.sent, null); assert.match(result.note!, /可划 0\.5 USD1，低于最小划转额/);
  assert.deepEqual((await once(long('600', { maxWithdraw: '40.123456789' }))).sent, [LONG, '40.12345678']);
  assert.deepEqual((await once(long('600'), { maxTransfer: '30' })).sent, [LONG, '30']);
});

test('划转：发送前在动作内重读，余额已变得不需要划转时不落盘也不发送', () => withHarness(async h => {
  await start(h);
  const subAccounts = h.aster.subAccounts.bind(h.aster);
  h.aster.subAccounts = async (...args) => { h.aster.setBalance(LONG, { available: '405' }); return subAccounts(...args); };
  await h.ex.tick();
  assert.deepEqual([h.aster.calls.transfer, transfers(h).length], [0, 0]);
  assert.match(pairOf(h).note ?? '', /发送前重读后不再划转/);
  assert.equal(pairOf(h).balances!.long.available, '405');
}));

test('划转：子账户移出主账户后余额读不到、已冻结或子账户列表读不到时不发送；启用时先核对归属', () => withHarness(async h => {
  h.aster.freeze(SHORT);
  h.ex.registerTransferPair(SIM_TRANSFER_PAIR);
  await assert.rejects(flip(h, true), code('sub_account_frozen'));
  assert.equal(pairOf(h).enabled, false);
  h.aster.freeze(SHORT, false);
  await flip(h, true);
  for (const [breakIt, repair, expected] of [
    [() => h.aster.reassign(SHORT, OTHER_MAIN), () => h.aster.reassign(SHORT, MAIN), /^余额读取失败/],
    [() => h.aster.freeze(LONG), () => h.aster.freeze(LONG, false), /已冻结，禁止划转/],
    [() => h.aster.inject({ operation: 'sub-accounts', mode: 'read-fail' }), () => undefined, /发送前复核失败/],
  ] as const) {
    breakIt();
    await run(h, 5_000);
    assert.deepEqual([h.aster.calls.transfer, transfers(h).length], [0, 0]);
    assert.match(pairOf(h).note ?? '', expected);
    repair();
  }
  await run(h, 5_000);
  assert.equal(last(h).state, 'confirmed');
}));

test('划转：交易所明确拒绝记为被拒并冷却；未发送只等一个检查间隔；之后都是新请求编号', () => withHarness(async h => {
  h.aster.inject({ operation: 'transfer', mode: 'reject' });
  await start(h, { maxTransfer: '30' });
  await h.ex.tick();
  const rejected = last(h);
  assert.deepEqual([rejected.state, rejected.basis, h.aster.ledger.length], ['rejected', null, 0]);
  assert.equal(pairOf(h).cooldownUntil, rejected.settledAt! + 30_000);
  await run(h, 25_000);
  assert.equal(h.aster.calls.transfer, 1, '冷却内不再发送');
  h.aster.inject({ operation: 'transfer', mode: 'not-sent' });
  await run(h, 5_000);
  const notSent = last(h);
  assert.deepEqual([notSent.state, h.aster.arrived.transfer, h.aster.ledger.length], ['not-sent', 1, 0]);
  await run(h, 5_000);
  const done = last(h);
  assert.deepEqual([done.state, done.amount, h.aster.ledger.length], ['confirmed', '30', 1]);
  assert.equal(new Set([rejected.id, notSent.id, done.id]).size, 3);
}));

test('未知划转：回报丢失但已到账，到期前不重发也不新发；到期读到两侧同一笔流水记为已执行，长冷却后按新余额重新规划', () => withHarness(async h => {
  const sent = await sendUnknown(h, 'lost-response', {}, { maxTransfer: '30' });
  assert.equal(sent.readyAt, sent.sentAt! + READY_MS);
  assert.deepEqual(sent.baseline, ['source', 'destination']);
  assert.match(pairOf(h).blocked ?? '', /本配对有未结清的划转/);
  await run(h, READY_MS - 5_000);
  assert.deepEqual([last(h).state, h.aster.calls.transfer], ['unknown', 1]);
  await run(h, 5_000);
  const settled = last(h);
  assert.deepEqual([settled.id, settled.state, settled.basis, settled.receipt], [sent.id, 'confirmed', 'late_receipt_confirmed', h.aster.ledger[0].tranId]);
  assert.match(settled.labelNote!, /无原交易编号，按金额与时间归属，可能误认其他同额划转$/);
  assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 300_000, '无原交易编号的确认用长冷却');
  assert.deepEqual(used(h), [h.aster.ledger[0].tranId]);
  await run(h, 295_000);
  assert.equal(h.aster.calls.transfer, 1);
  await run(h, 5_000);
  const next = last(h);
  assert.notEqual(next.id, sent.id);
  assert.deepEqual([next.state, next.basis, next.amount, h.aster.calls.transfer, h.aster.ledger.length], ['confirmed', 'acknowledged', '30', 2, 2]);
  assert.deepEqual([h.aster.available(LONG), h.aster.available(SHORT)], ['540', '460']);
}));

test('未知划转：请求未到达，到期完整读取两侧均无流水记为未执行，短冷却后发新请求', () => withHarness(async h => {
  const sent = await sendUnknown(h, 'lost-request');
  await run(h, READY_MS);
  const settled = last(h);
  assert.deepEqual([settled.state, settled.basis, settled.receipt, settled.evidence], ['expired-not-executed', 'nonce_expired_no_receipt', null, 0]);
  assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 30_000);
  assert.deepEqual([h.aster.calls.transfer, h.aster.ledger.length], [1, 0]);
  await run(h, 30_000);
  const next = last(h);
  assert.notEqual(next.id, sent.id);
  assert.deepEqual([next.state, next.amount, h.aster.calls.transfer, h.aster.ledger.length], ['confirmed', '100', 2, 1]);
}));

test('未知划转：只有转出侧有流水记为部分匹配，是否执行未能确认，用长冷却', () => withHarness(async h => {
  await sendUnknown(h, 'one-side');
  await run(h, READY_MS);
  const settled = last(h);
  assert.deepEqual([settled.state, settled.basis, settled.receipt, settled.evidence], ['expired-unverified', 'nonce_expired_partial_receipt', null, 1]);
  assert.match(settled.labelNote!, /只部分匹配/);
  assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 300_000);
  assert.deepEqual(used(h), []);
  assert.deepEqual([h.aster.calls.transfer, h.aster.arrived.transfer], [1, 1]);
}));

test('未知划转：流水延迟可见，到期前出现则确认；到期后才出现会被记为未执行，之后按已变化的余额规划而不重复划转', async () => {
  await withHarness(async h => {
    await sendUnknown(h, 'delayed-history', { delayMs: 100_000 });
    await run(h, READY_MS);
    assert.deepEqual([last(h).state, last(h).basis], ['confirmed', 'late_receipt_confirmed']);
  });
  await withHarness(async h => {
    await sendUnknown(h, 'one-side', { delayMs: 170_000 });
    await run(h, READY_MS);
    assert.deepEqual([last(h).state, last(h).basis], ['confirmed', 'late_receipt_confirmed']);
  });
  await withHarness(async h => {
    await sendUnknown(h, 'delayed-history', { delayMs: 400_000 });
    await run(h, READY_MS);
    assert.deepEqual([last(h).state, last(h).basis], ['expired-not-executed', 'nonce_expired_no_receipt'], '已到账但流水未出现：标签错误，属已登记的限制');
    await run(h, 60_000);
    assert.deepEqual([h.aster.calls.transfer, h.aster.ledger.length], [1, 1], '重新规划读到的是已平衡的余额');
    assert.deepEqual([pairOf(h).balances!.long.available, pairOf(h).balances!.short.available], ['500', '500']);
  });
});

test('未知划转：发送前已有的同额外部划转被基线排除；没有基线时也不拿早于本次请求的流水确认', async () => {
  await withHarness(async h => {
    h.aster.addExternalTransfer(LONG, SHORT, '100', h.clock.now - 10_000);
    const sent = await sendUnknown(h, 'lost-request');
    assert.deepEqual(sent.baseline, ['source', 'destination']);
    await run(h, READY_MS);
    assert.deepEqual([last(h).state, last(h).basis, last(h).evidence], ['expired-not-executed', 'nonce_expired_no_receipt', 0]);
  });
  await withHarness(async h => {
    h.aster.addExternalTransfer(LONG, SHORT, '100', h.clock.now - 10_000);
    h.ex.registerTransferPair(SIM_TRANSFER_PAIR);
    await flip(h, true);
    h.aster.inject({ operation: 'history', mode: 'read-fail', times: 2 });
    h.aster.inject({ operation: 'transfer', mode: 'lost-request' });
    await h.ex.tick();
    assert.deepEqual([last(h).state, last(h).baseline], ['unknown', []], '基线读取失败不阻塞发送');
    await run(h, READY_MS);
    const settled = last(h);
    assert.deepEqual([settled.state, settled.basis, settled.evidence], ['expired-unverified', 'nonce_expired_partial_receipt', 2]);
    assert.match(settled.labelNote!, /时间早于本次请求/);
  });
});

test('未知划转：发送后出现的同额外部划转无法与本次区分——请求未到达时被误认为已执行，本次也到账时归属歧义', async () => {
  await withHarness(async h => {
    await sendUnknown(h, 'lost-request');
    h.advance(20_000);
    const foreign = h.aster.addExternalTransfer(LONG, SHORT, '100');
    await run(h, READY_MS - 20_000);
    const settled = last(h);
    assert.deepEqual([settled.state, settled.basis, settled.receipt, h.aster.ledger.length], ['confirmed', 'late_receipt_confirmed', foreign, 0], '按侧、金额、时间归属的已知误判');
    assert.match(settled.labelNote!, /可能误认其他同额划转/);
  });
  await withHarness(async h => {
    await sendUnknown(h, 'lost-response');
    h.advance(20_000);
    h.aster.addExternalTransfer(LONG, SHORT, '100');
    await run(h, READY_MS - 20_000);
    const settled = last(h);
    assert.deepEqual([settled.state, settled.basis, settled.receipt, settled.evidence], ['expired-unverified', 'nonce_expired_ambiguous_receipt', null, 4]);
    assert.match(settled.labelNote!, /同额候选流水 2\/2 笔/);
    assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 300_000);
  });
});

test('未知划转：两侧各一笔但交易编号不同，不确认，记为归属歧义', () => withHarness(async h => {
  h.aster.splitTranIds = true;
  await sendUnknown(h, 'lost-response');
  await run(h, READY_MS);
  const settled = last(h);
  assert.deepEqual([settled.state, settled.basis, settled.receipt], ['expired-unverified', 'nonce_expired_ambiguous_receipt', null]);
  assert.match(settled.labelNote!, /同额候选流水 1\/1 笔/);
  assert.deepEqual([h.aster.calls.transfer, h.aster.arrived.transfer], [1, 1]);
}));

test('未知划转：回执未确认成功但带交易编号时只认该编号，其他同额流水不干扰，用普通冷却；未入账则记为未执行', async () => {
  await withHarness(async h => {
    const sent = await sendUnknown(h, 'ack-not-success', { hint: true });
    assert.equal(sent.tranId, h.aster.ledger[0].tranId);
    h.advance(20_000);
    h.aster.addExternalTransfer(LONG, SHORT, '100');
    await run(h, READY_MS - 20_000);
    const settled = last(h);
    assert.deepEqual([settled.state, settled.basis, settled.receipt, settled.labelNote], ['confirmed', 'late_receipt_confirmed', sent.tranId, null]);
    assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 30_000);
  });
  await withHarness(async h => {
    const sent = await sendUnknown(h, 'ack-not-success', { applied: false });
    assert.equal(sent.tranId, null);
    await run(h, READY_MS);
    assert.deepEqual([last(h).state, last(h).basis, h.aster.ledger.length], ['expired-not-executed', 'nonce_expired_no_receipt', 0]);
  });
});

test('未知划转：流水读不到时推迟，推迟到上限后按无证据结算为不可读；全程不重发', () => withHarness(async h => {
  await sendUnknown(h, 'lost-response');
  h.aster.inject({ operation: 'history', mode: 'read-fail', times: 10_000 });
  await run(h, READY_MS);
  assert.equal(last(h).state, 'unknown');
  assert.match(last(h).note!, /流水暂不可读.*推迟结算/);
  await run(h, DEFER_MS - 5_000);
  assert.equal(last(h).state, 'unknown');
  await run(h, 5_000);
  const settled = last(h);
  assert.deepEqual([settled.state, settled.basis, settled.evidence, h.aster.calls.transfer], ['expired-unverified', 'nonce_expired_unreadable', 0, 1]);
  assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 300_000);
}));

test('未知划转：一侧读取失败时保留另一侧证据并推迟，之后同一次两侧完整读取才确认；始终读不完整则按部分匹配结算', async () => {
  await withHarness(async h => {
    await sendUnknown(h, 'lost-response');
    h.aster.inject({ operation: 'history', mode: 'read-fail', accountId: SHORT });
    await run(h, READY_MS);
    assert.deepEqual([last(h).state, last(h).evidence], ['unknown', 1]);
    await run(h, 5_000);
    assert.deepEqual([last(h).state, last(h).basis, last(h).evidence], ['confirmed', 'late_receipt_confirmed', 2]);
  });
  await withHarness(async h => {
    await sendUnknown(h, 'lost-response');
    h.aster.inject({ operation: 'history', mode: 'incomplete-history', times: 10_000 });
    await run(h, READY_MS + DEFER_MS - 5_000);
    assert.deepEqual([last(h).state, last(h).evidence], ['unknown', 2]);
    await run(h, 5_000);
    const settled = last(h);
    assert.deepEqual([settled.state, settled.basis, settled.receipt], ['expired-unverified', 'nonce_expired_partial_receipt', null]);
    assert.match(settled.labelNote!, /两侧均见该笔流水，但本次读取不完整/);
  });
});

test('未知划转：配对账户更换后到期结算为身份已变，不读流水；更换使配对停用', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '400' });
  await sendUnknown(h, 'lost-response');
  const view = h.ex.registerTransferPair({ ...SIM_TRANSFER_PAIR, short: THIRD });
  assert.deepEqual([view.enabled, view.current?.state], [false, 'unknown']);
  const reads = h.aster.calls.history;
  await run(h, READY_MS);
  const settled = last(h);
  assert.deepEqual([settled.state, settled.basis, h.aster.calls.history], ['expired-unverified', 'identity_changed', reads]);
  assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 30_000);
}));

test('未知划转：已归属给之前划转的流水不再作为后一笔的证据', () => withHarness(async h => {
  await start(h, { maxTransfer: '30', cooldownMs: 1_000, checkIntervalMs: 1_000 });
  await h.ex.tick();
  const first = last(h);
  assert.deepEqual([first.state, used(h)], ['confirmed', [first.receipt]]);
  // No pre-send snapshot this time, so only the used-receipt list keeps the first transfer's receipts out.
  h.aster.inject({ operation: 'history', mode: 'read-fail', times: 2 });
  h.aster.inject({ operation: 'transfer', mode: 'lost-request' });
  await run(h, 5_000);
  const second = last(h);
  assert.deepEqual([second.state, second.amount, second.baseline], ['unknown', '30', []]);
  await run(h, READY_MS);
  assert.deepEqual([last(h).id, last(h).state, last(h).basis, last(h).evidence], [second.id, 'expired-not-executed', 'nonce_expired_no_receipt', 0]);
}));

test('已回执的划转：余额快照早于回执或读取失败时保持已回执，只读重试，从不重发', () => withHarness(async h => {
  h.aster.balanceAgeMs = 1_000;
  await start(h, { maxTransfer: '30' });
  await h.ex.tick();
  assert.equal(last(h).state, 'acknowledged');
  assert.match(last(h).note!, /余额快照早于划转回执.*不重发/);
  assert.equal(pairOf(h).current?.state, 'acknowledged');
  h.aster.balanceAgeMs = 0;
  h.aster.inject({ operation: 'balance', mode: 'read-fail', accountId: SHORT, times: 3 });
  await run(h, 15_000);
  assert.deepEqual([last(h).state, h.aster.calls.transfer], ['acknowledged', 1]);
  await run(h, 5_000);
  assert.deepEqual([last(h).state, last(h).basis, h.aster.calls.transfer, h.aster.ledger.length], ['confirmed', 'acknowledged', 1, 1]);
  assert.deepEqual([pairOf(h).balances!.long.available, pairOf(h).balances!.short.available], ['570', '430']);
}));

test('恢复：落盘后、发送前中断的划转记为未发送，同实例下一轮与接管后都如此，传输从未被调用', async () => {
  const interruptAfterPrepare = (h: Harness) => {
    const tx = h.store.tx;
    let armed = true;
    h.store.tx = (operation => {
      if (armed && h.store.db.prepare("SELECT 1 FROM transfers WHERE state = 'prepared'").get()) { armed = false; throw new Error('模拟磁盘写入失败'); }
      return tx(operation);
    }) as typeof tx;
  };
  await withHarness(async h => {
    await start(h);
    interruptAfterPrepare(h);
    await h.ex.tick();
    assert.deepEqual([last(h).state, h.aster.calls.transfer], ['prepared', 0]);
    await run(h, 5_000);
    assert.deepEqual([last(h).state, h.aster.calls.transfer], ['not-sent', 0]);
    await run(h, 5_000);
    const [first, second] = transfers(h);
    assert.deepEqual([first.state, second.state, h.aster.arrived.transfer], ['not-sent', 'confirmed', 1]);
    assert.match(first.note!, /发送前中断，传输未调用/);
    assert.notEqual(first.id, second.id);
  });
  await withHarness(async h => {
    await start(h);
    interruptAfterPrepare(h);
    await h.ex.tick();
    assert.equal(last(h).state, 'prepared');
    takeover(h);
    assert.deepEqual([last(h).state, last(h).recovered, h.aster.calls.transfer], ['not-sent', false, 0]);
    assert.match(last(h).note!, /^恢复：/);
    takeover(h);
    assert.equal(transfers(h).length, 1, '再次接管不改变已恢复的结果');
    await h.ex.tick();
    assert.deepEqual([last(h).state, h.aster.arrived.transfer], ['confirmed', 1]);
  });
});

test('恢复：发送中被接管的划转记为未知且不重发，旧实例的结果写入被拒；结清前任何配对都不新发，到期后照常结算', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '900' });
  h.aster.openSubAccount(MAIN, FOURTH, { available: '100' });
  h.ex.registerTransferPair({ id: 'z-pair', mainAccountId: MAIN, long: THIRD, short: FOURTH });
  await flip(h, true, 'z-pair');
  h.aster.inject({ operation: 'transfer', mode: 'hang-after-apply' });
  await start(h);
  const abandoned = h.ex.tick().then(() => null, (error: unknown) => error);
  await waitFor(() => h.aster.arrived.transfer === 1 && last(h)?.state === 'sending', '划转已出站');
  takeover(h);
  const recovered = last(h);
  assert.deepEqual([recovered.state, recovered.recovered], ['unknown', true]);
  assert.ok(await abandoned instanceof WriterLostError);
  assert.equal(last(h).state, 'unknown');
  await h.ex.tick();
  assert.match(pairOf(h, 'z-pair').blocked ?? '', /接管后有未结清的划转/);
  takeover(h);
  await run(h, recovered.readyAt! - h.clock.now - 5_000);
  assert.deepEqual([last(h).state, h.aster.calls.transfer], ['unknown', 1], '不共用账户的配对在结清前也不发送');
  await run(h, 5_000);
  const [first, second] = transfers(h);
  assert.deepEqual([first.id, first.state, first.basis], [recovered.id, 'confirmed', 'late_receipt_confirmed']);
  assert.deepEqual([second.pairId, second.state, second.amount, h.aster.calls.transfer], ['z-pair', 'confirmed', '400', 2]);
  assert.deepEqual(h.aster.ledger.map(item => item.source), [LONG, THIRD]);
}));

test('恢复：发送前写者租约已失效则请求不出站；接管后按未知到期结算为未执行', () => withHarness(async h => {
  await start(h);
  const transfer = h.aster.transfer.bind(h.aster);
  h.aster.transfer = async (...args) => { h.clock.now += 61_000; return transfer(...args); };
  await assert.rejects(h.ex.tick(), error => error instanceof WriterLostError);
  h.aster.transfer = transfer;
  assert.deepEqual([h.aster.arrived.transfer, h.aster.ledger.length, last(h).state], [0, 0, 'sending']);
  h.restart();
  assert.equal(h.ex.acquire(), true);
  assert.equal(last(h).state, 'unknown');
  await run(h, last(h).readyAt! - h.clock.now);
  assert.deepEqual([last(h).state, last(h).basis, h.aster.arrived.transfer], ['expired-not-executed', 'nonce_expired_no_receipt', 0]);
}));

test('恢复：已回执未刷新余额时被接管，新实例只刷新余额，不重发', () => withHarness(async h => {
  h.aster.balanceAgeMs = 1_000;
  await start(h);
  await h.ex.tick();
  assert.equal(last(h).state, 'acknowledged');
  h.aster.balanceAgeMs = 0;
  takeover(h);
  assert.deepEqual([last(h).state, last(h).recovered], ['acknowledged', true]);
  await h.ex.tick();
  assert.deepEqual([last(h).state, last(h).basis, h.aster.calls.transfer, h.aster.ledger.length], ['confirmed', 'acknowledged', 1, 1]);
}));

test('恢复：结算事务失败时标签、终态、已用流水与冷却一起回滚，下一轮整体重做', () => withHarness(async h => {
  await sendUnknown(h, 'lost-response');
  await run(h, READY_MS - 5_000);
  const before = stored(h);
  const tx = h.store.tx;
  let armed = true;
  h.store.tx = (operation => tx(() => {
    const result = operation();
    if (armed && h.store.db.prepare("SELECT 1 FROM transfers WHERE state = 'confirmed'").get()) { armed = false; throw new Error('模拟提交前崩溃'); }
    return result;
  })) as typeof tx;
  await run(h, 5_000);
  assert.equal(armed, false);
  assert.deepEqual([last(h).state, last(h).basis], ['unknown', null]);
  assert.deepEqual([stored(h).cooldownUntil, used(h)], [before.cooldownUntil, []]);
  await run(h, 5_000);
  const settled = last(h);
  assert.deepEqual([settled.state, settled.basis], ['confirmed', 'late_receipt_confirmed']);
  assert.deepEqual([stored(h).cooldownUntil, used(h)], [settled.settledAt! + 300_000, [settled.receipt]]);
  takeover(h);
  await h.ex.tick();
  assert.deepEqual([transfers(h).length, last(h).state, h.aster.calls.transfer], [1, 'confirmed', 1], '已结算的划转在接管后不变');
}));

test('互斥：共用账户的另一配对在未结清划转结算前不发送；结算的已用流水与长冷却同步给它，冷却后按新余额划转', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '300' });
  h.ex.registerTransferPair({ id: 'z-pair', mainAccountId: MAIN, long: LONG, short: THIRD });
  await flip(h, true, 'z-pair');
  await sendUnknown(h, 'lost-response');
  assert.match(pairOf(h, 'z-pair').blocked ?? '', /共用账户的配对有未结清的划转/);
  await run(h, READY_MS - 5_000);
  assert.equal(h.aster.calls.transfer, 1);
  await run(h, 5_000);
  const first = last(h);
  assert.deepEqual([first.state, first.basis, transfers(h).length], ['confirmed', 'late_receipt_confirmed', 1]);
  // Confirmed without the venue's transaction id: whether this receipt was really its own stays open, for every pair on these accounts.
  assert.deepEqual([used(h, 'z-pair'), stored(h, 'z-pair').cooldownUntil, stored(h, 'z-pair').freshAfter], [[first.receipt], first.settledAt! + 300_000, first.settledAt]);
  await run(h, 295_000);
  assert.equal(h.aster.calls.transfer, 1);
  await run(h, 5_000);
  const second = last(h);
  assert.deepEqual([second.pairId, second.state, second.amount], ['z-pair', 'confirmed', '100']);
  assert.deepEqual(h.aster.ledger.map(item => [item.source, item.destination, item.amount]), [[LONG, SHORT, '100'], [LONG, THIRD, '100']]);
}));

test('开关：停用后不新发，未结清的划转照常结算；重放旧的启用请求不会撤销之后的停用', () => withHarness(async h => {
  h.ex.registerTransferPair({ ...SIM_TRANSFER_PAIR, config: { maxTransfer: '30' } });
  const enableId = randomUUID();
  await h.ex.setTransferEnabled({ pairId: PAIR, enabled: true, requestId: enableId }, SESSION);
  h.aster.inject({ operation: 'transfer', mode: 'lost-request' });
  await h.ex.tick();
  await flip(h, false);
  const replay = await h.ex.setTransferEnabled({ pairId: PAIR, enabled: true, requestId: enableId }, SESSION);
  assert.equal(replay.enabled, false);
  await assert.rejects(h.ex.setTransferEnabled({ pairId: PAIR, enabled: false, requestId: enableId }, SESSION), code('request_reused'));
  await assert.rejects(h.ex.setTransferEnabled({ pairId: PAIR, enabled: true, requestId: enableId }, 'another-session'), code('request_reused'));
  await assert.rejects(flip(h, true, 'no-such-pair'), code('pair_missing'));
  await run(h, READY_MS + 120_000);
  assert.deepEqual([last(h).state, h.aster.calls.transfer], ['expired-not-executed', 1]);
  // Changing only the settings keeps the switch and the cooldown.
  assert.equal(h.ex.registerTransferPair({ ...SIM_TRANSFER_PAIR, config: { maxTransfer: '50' } }).config.maxTransfer, '50');
  await flip(h, true);
  await h.ex.tick();
  assert.deepEqual([last(h).state, last(h).amount], ['confirmed', '50']);
}));

test('共享写者登记：注入登记时划转不接入登记，因此不能启用；已启用的配对也不发送', async () => {
  const c = await controlledHarness(), h = c.h;
  try {
    await start(h);
    c.enable();
    takeover(h);
    await run(h, 30_000);
    assert.deepEqual([h.aster.calls.transfer, h.aster.calls.balance, transfers(h).length], [0, 0, 0]);
    assert.match(pairOf(h).blocked ?? '', /共享写者登记/);
    await flip(h, false);
    await assert.rejects(flip(h, true), code('transfer_control_unsupported'));
    assert.equal(pairOf(h).enabled, false);
  } finally { c.dispose(); }
});

test('契约：aster 不是交易场所，交易意图与账户绑定都拒绝；配对与配置越界被拒绝', () => withHarness(async h => {
  bindAccounts(h.ex);
  const intent = openIntent();
  intent.legs[1].venue = 'aster';
  await assert.rejects(h.ex.preview(intent, SESSION), code('invalid_value'));
  assert.throws(() => h.ex.registerAccount({ venue: 'aster', environment: 'simulated', accountId: 'AS1', accountMode: 'standard', credentialVersion: 1 }), code('invalid_value'));
  const register = (change: Record<string, unknown>, config?: Record<string, unknown>) => () => h.ex.registerTransferPair({ ...SIM_TRANSFER_PAIR, ...change, ...(config ? { config } : {}) });
  assert.throws(register({ short: LONG }), code('pair_accounts'));
  assert.throws(register({ long: MAIN }), code('pair_accounts'));
  assert.throws(register({ long: LONG.toUpperCase() }), code('invalid_value'));
  assert.throws(register({ extra: 1 }), code('unknown_field'));
  for (const config of [{ bufferRatio: '1' }, { minTransfer: '0.000000001' }, { minTransfer: '5', maxTransfer: '4' }, { threshold: '-1' }, { cooldownMs: 999 }, { checkIntervalMs: 3_600_001 }, { maxTransfer: 30 }, { reserve: '1' }]) {
    assert.throws(register({}, config), ContractError, JSON.stringify(config));
  }
  assert.deepEqual(h.ex.registerTransferPair(SIM_TRANSFER_PAIR).config, { threshold: '10', minTransfer: '1', maxTransfer: '1000', bufferRatio: '0.05', cooldownMs: 30_000, checkIntervalMs: 5_000 });
  assert.equal(pairOf(h).enabled, false, '新配对默认停用');
  // The same two sub-accounts under the same main account, whichever side each is on.
  assert.throws(() => h.ex.registerTransferPair({ id: 'same', mainAccountId: MAIN, long: LONG, short: SHORT }), code('pair_duplicate'));
  assert.throws(() => h.ex.registerTransferPair({ id: 'swapped', mainAccountId: MAIN, long: SHORT, short: LONG }), code('pair_duplicate'));
  h.ex.registerTransferPair({ id: 'sharing-one', mainAccountId: MAIN, long: LONG, short: THIRD });
  assert.throws(() => h.ex.registerTransferPair({ id: 'sharing-one', mainAccountId: MAIN, long: SHORT, short: LONG }), code('pair_duplicate'), '改成与已有配对相同也拒绝');
  assert.deepEqual(h.ex.transferPairs().map(pair => pair.id).sort(), [PAIR, 'sharing-one'].sort());
  await run(h, 10_000);
  assert.equal(h.aster.calls.balance, 0, '停用的配对不读取也不发送');
}));

test('已回执的划转：余额一直读不到时在刷新上限后按回执结清并注明余额未刷新；接管后不共用账户的配对恢复发送，该笔从未重发', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '900' });
  h.aster.openSubAccount(MAIN, FOURTH, { available: '100' });
  h.ex.registerTransferPair({ id: 'z-pair', mainAccountId: MAIN, long: THIRD, short: FOURTH });
  h.aster.balanceAgeMs = 1_000;
  await start(h);
  await h.ex.tick();
  const sent = last(h);
  assert.equal(sent.state, 'acknowledged');
  h.aster.balanceAgeMs = 0;
  h.aster.reassign(SHORT, OTHER_MAIN);
  await run(h, 120_000);
  takeover(h);
  await flip(h, true, 'z-pair');
  await run(h, sent.ackAt! + REFRESH_MS - h.clock.now - 5_000);
  assert.deepEqual([last(h).state, last(h).recovered, h.aster.calls.transfer], ['acknowledged', true, 1]);
  assert.match(pairOf(h, 'z-pair').blocked ?? '', /接管后有未结清的划转/);
  await run(h, 5_000);
  const [first, second] = transfers(h);
  assert.deepEqual([first.id, first.state, first.basis, first.receipt, first.balancesRefreshedAt], [sent.id, 'confirmed', 'acknowledged', h.aster.ledger[0].tranId, null]);
  assert.match(first.labelNote!, /^余额未刷新：/);
  assert.equal(first.settledAt, sent.ackAt! + REFRESH_MS);
  assert.deepEqual([used(h), stored(h).cooldownUntil, stored(h).balances], [[first.receipt], sent.sentAt! + 30_000, null]);
  assert.deepEqual([second.pairId, second.state, second.amount, h.aster.calls.transfer], ['z-pair', 'confirmed', '400', 2]);
  const settledEvent = h.store.db.prepare("SELECT json FROM events WHERE type = 'transfer-settled' ORDER BY seq LIMIT 1").get() as { json: string };
  assert.equal(JSON.parse(settledEvent.json).balancesRefreshed, false);
  await run(h, 120_000);
  assert.deepEqual(h.aster.ledger.map(item => item.source), [LONG, THIRD], '读不到余额的配对不再发送，原请求也没有重发');
  assert.match(pairOf(h).note ?? '', /余额读取失败/);
}));

test('划转：余额快照超过时效不发送；上一笔结算后未取得更新的快照也不发送；发送前重读同样校验', () => withHarness(async h => {
  h.aster.balanceAgeMs = 9_000;
  await start(h, { maxTransfer: '30', cooldownMs: 1_000 });
  await h.ex.tick();
  assert.deepEqual([h.aster.calls.transfer, transfers(h).length], [0, 0]);
  assert.match(pairOf(h).note ?? '', /^余额快照已超过 8000 毫秒/);
  h.aster.balanceAgeMs = 0;
  await run(h, 5_000);
  const first = last(h);
  assert.equal(first.state, 'confirmed');
  // Young enough, but received one second before the settlement above.
  h.aster.balanceAgeMs = 6_000;
  await run(h, 5_000);
  assert.equal(h.aster.calls.transfer, 1);
  assert.match(pairOf(h).note ?? '', /^余额快照早于上一笔划转的结算时刻/);
  h.aster.balanceAgeMs = 0;
  await run(h, 5_000);
  const second = last(h);
  assert.notEqual(second.id, first.id);
  assert.deepEqual([second.state, h.aster.calls.transfer], ['confirmed', 2]);
  const subAccounts = h.aster.subAccounts.bind(h.aster);
  h.aster.subAccounts = async (...args) => { h.aster.balanceAgeMs = 9_000; return subAccounts(...args); };
  await run(h, 5_000);
  assert.equal(h.aster.calls.transfer, 2);
  assert.match(pairOf(h).note ?? '', /^发送前重读：余额快照已超过 8000 毫秒/);
}));

test('划转：发送前基线读取超时不阻塞发送，按没有基线的保守路径结算', () => withHarness(async h => {
  h.aster.addExternalTransfer(LONG, SHORT, '100', h.clock.now - 10_000);
  h.ex.registerTransferPair(SIM_TRANSFER_PAIR);
  await flip(h, true);
  h.aster.inject({ operation: 'history', mode: 'hang', times: 2 });
  h.aster.inject({ operation: 'transfer', mode: 'lost-request' });
  const began = performance.now();
  await h.ex.tick();
  assert.ok(performance.now() - began < 2_000, '基线只等自己的短超时');
  assert.deepEqual([last(h).state, last(h).baseline], ['unknown', []]);
  h.aster.releaseHung();
  await run(h, READY_MS);
  assert.deepEqual([last(h).state, last(h).basis, h.aster.calls.transfer], ['expired-unverified', 'nonce_expired_partial_receipt', 1]);
}, { budgets: { transferBaselineTimeoutMs: 30 } }));

test('划转：评估途中配置被更改时本轮不发送，下一轮按新配置规划', () => withHarness(async h => {
  await start(h);
  const subAccounts = h.aster.subAccounts.bind(h.aster);
  let changed = false;
  h.aster.subAccounts = async (...args) => {
    if (!changed) { changed = true; h.ex.registerTransferPair({ ...SIM_TRANSFER_PAIR, config: { maxTransfer: '30' } }); }
    return subAccounts(...args);
  };
  await h.ex.tick();
  assert.deepEqual([changed, h.aster.calls.transfer, transfers(h).length], [true, 0, 0]);
  assert.match(pairOf(h).note ?? '', /配置在评估途中已更改/);
  await run(h, 5_000);
  assert.deepEqual([last(h).state, last(h).amount, h.aster.calls.transfer], ['confirmed', '30', 1]);
}));

test('划转规划：可用余额为负时照常计入差额；转出侧为负时没有可划金额', async () => {
  await withHarness(async h => {
    h.aster.setBalance(LONG, { available: '-50', equity: '-50', maxWithdraw: '0' });
    await start(h);
    await h.ex.tick();
    assert.deepEqual(h.aster.ledger.map(item => [item.source, item.destination, item.amount]), [[SHORT, LONG, '225']]);
  });
  await withHarness(async h => {
    h.aster.setBalance(LONG, { available: '-10', equity: '-10', maxWithdraw: '0' });
    h.aster.setBalance(SHORT, { available: '-100', equity: '-100', maxWithdraw: '0' });
    await start(h);
    await h.ex.tick();
    assert.deepEqual([h.aster.calls.transfer, transfers(h).length], [0, 0]);
    assert.match(pairOf(h).note ?? '', /转出侧多侧.*可划 0 USD1，低于最小划转额/);
    assert.equal(pairOf(h).balances!.long.available, '-10');
  });
});

test('划转：连续未发送按检查间隔指数退避，上限为配置冷却；重启后退避仍然有效，发出后清零', () => withHarness(async h => {
  h.aster.inject({ operation: 'transfer', mode: 'not-sent', times: 6 });
  await start(h, { maxTransfer: '30' });
  await h.ex.tick();
  const after = async (ms: number) => { await run(h, ms); return h.aster.calls.transfer; };
  assert.equal(h.aster.calls.transfer, 1);
  assert.equal(await after(5_000), 2, '第一次只等一个检查间隔');
  assert.equal(await after(5_000), 2);
  assert.equal(await after(5_000), 3, '第二次等两个间隔');
  assert.equal(await after(15_000), 3);
  assert.equal(await after(5_000), 4, '第三次等四个间隔');
  takeover(h);
  await h.ex.tick();
  assert.deepEqual([h.aster.calls.transfer, stored(h).notSentStreak, stored(h).nextCheckAt], [5, 5, h.clock.now + 30_000], '重启后延续，等待封顶为配置冷却 30 秒');
  assert.equal(await after(25_000), 5);
  assert.equal(await after(5_000), 6);
  assert.equal(await after(25_000), 6);
  assert.equal(await after(5_000), 7);
  assert.deepEqual([last(h).state, stored(h).notSentStreak, h.aster.arrived.transfer], ['confirmed', 0, 1]);
  assert.equal(new Set(transfers(h).map(item => item.id)).size, 7, '每次都是新的请求编号');
}));

test('保留期：已结清的划转记录与启停命令超过保留期后删除，未结清的保留；已用流水不随记录删除', () => withHarness(async h => {
  await start(h, { maxTransfer: '30', cooldownMs: 1_000 });
  await h.ex.tick();
  const first = last(h);
  assert.equal(first.state, 'confirmed');
  h.aster.inject({ operation: 'transfer', mode: 'lost-request' });
  await run(h, 5_000);
  const open = last(h);
  assert.equal(open.state, 'unknown');
  h.advance(61_000);
  const removed = h.ex.prune();
  assert.deepEqual([removed.transfers, removed.commands], [1, 1]);
  assert.deepEqual(transfers(h).map(item => [item.id, item.state]), [[open.id, 'unknown']]);
  assert.equal((h.store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE kind = 'transfer-enable'").get() as { n: number }).n, 0);
  assert.deepEqual(used(h), [first.receipt]);
  assert.equal(pairOf(h).enabled, true);
  await run(h, READY_MS);
  assert.equal(transfers(h).find(item => item.id === open.id)?.state, 'expired-not-executed');
}, { budgets: { historyRetentionMs: 60_000 } }));

test('已用流水：按时间窗口保留，不按条数截断；超过窗口的在下一次落盘时清除', () => withHarness(async h => {
  h.aster.setBalance(LONG, { available: '100000', equity: '100000' });
  await start(h, { maxTransfer: '30', cooldownMs: 1_000, checkIntervalMs: 1_000 });
  await run(h, 105_000, 1_000);
  const sent = h.aster.ledger.length;
  assert.ok(sent > 100, String(sent));
  assert.deepEqual(used(h), h.aster.ledger.map(item => item.tranId));
  await flip(h, false);
  // Two clock tolerances plus the history span.
  h.advance(2 * 60_000 + 180_000);
  await flip(h, true);
  await h.ex.tick();
  assert.equal(h.aster.ledger.length, sent + 1);
  assert.deepEqual(used(h), [h.aster.ledger.at(-1)!.tranId]);
}));

test('恢复：同实例内发送结果写入失败，下一轮记为未知且不重发，到期按流水结算，冷却后才发新请求', () => withHarness(async h => {
  await start(h, { maxTransfer: '30' });
  const tx = h.store.tx;
  let armed = true;
  h.store.tx = (operation => {
    if (armed && h.store.db.prepare("SELECT 1 FROM transfers WHERE state = 'sending'").get()) { armed = false; throw new Error('模拟磁盘写入失败'); }
    return tx(operation);
  }) as typeof tx;
  await h.ex.tick();
  const sent = last(h);
  assert.deepEqual([armed, sent.state, h.aster.arrived.transfer, h.aster.ledger.length], [false, 'sending', 1, 1]);
  await run(h, 5_000);
  assert.deepEqual([last(h).id, last(h).state, last(h).recovered, h.aster.calls.transfer], [sent.id, 'unknown', false, 1]);
  assert.match(last(h).note!, /^中断：发送中断，结果未知/);
  await run(h, READY_MS);
  const settled = last(h);
  assert.deepEqual([settled.id, settled.state, settled.basis, h.aster.calls.transfer], [sent.id, 'confirmed', 'late_receipt_confirmed', 1]);
  await run(h, settled.settledAt! + 300_000 - h.clock.now - 5_000);
  assert.equal(h.aster.calls.transfer, 1);
  await run(h, 5_000);
  assert.notEqual(last(h).id, sent.id);
  assert.deepEqual([last(h).state, h.aster.calls.transfer, h.aster.ledger.length], ['confirmed', 2, 2]);
}));

test('未知划转：部分匹配、归属歧义、不可读结算后，经过长冷却按新余额发新请求，原请求从未重发', async () => {
  const cases: [string, (h: Harness) => Promise<Awaited<ReturnType<typeof sendUnknown>>>, number][] = [
    ['nonce_expired_partial_receipt', h => sendUnknown(h, 'one-side', {}, { maxTransfer: '30' }), READY_MS],
    ['nonce_expired_ambiguous_receipt', h => { h.aster.splitTranIds = true; return sendUnknown(h, 'lost-response', {}, { maxTransfer: '30' }); }, READY_MS],
    ['nonce_expired_unreadable', async h => {
      const sent = await sendUnknown(h, 'lost-response', {}, { maxTransfer: '30' });
      h.aster.inject({ operation: 'history', mode: 'read-fail', times: 10_000 });
      return sent;
    }, READY_MS + DEFER_MS],
  ];
  for (const [basis, send, wait] of cases) await withHarness(async h => {
    const sent = await send(h);
    await run(h, wait);
    const settled = last(h);
    assert.deepEqual([settled.id, settled.state, settled.basis], [sent.id, 'expired-unverified', basis]);
    h.aster.clearFaults();
    await run(h, settled.settledAt! + 300_000 - h.clock.now - 5_000);
    assert.deepEqual([h.aster.calls.transfer, h.aster.arrived.transfer], [1, 1], basis);
    await run(h, 5_000);
    const next = last(h);
    assert.notEqual(next.id, sent.id);
    assert.deepEqual([next.state, next.basis, next.amount, h.aster.calls.transfer, h.aster.ledger.length], ['confirmed', 'acknowledged', '30', 2, 2], basis);
    assert.deepEqual([h.aster.available(LONG), h.aster.available(SHORT)], ['540', '460'], '第二笔按第一笔到账后的余额规划');
  });
});

test('未知划转：发送前同额流水超过 100 条时不记基线；证据最多保留 20 条', () => withHarness(async h => {
  for (let i = 0; i < 101; i++) h.aster.addExternalTransfer(LONG, SHORT, '100', h.clock.now - 10_000);
  const sent = await sendUnknown(h, 'lost-request');
  assert.deepEqual(sent.baseline, []);
  await run(h, READY_MS);
  const settled = last(h);
  assert.deepEqual([settled.id, settled.state, settled.basis, settled.evidence, h.aster.calls.transfer], [sent.id, 'expired-unverified', 'nonce_expired_partial_receipt', 20, 1]);
}));

test('未知划转：长时间停机后首次读取即不可读，不再推迟，当轮按不可读结算', () => withHarness(async h => {
  const sent = await sendUnknown(h, 'lost-response');
  h.aster.inject({ operation: 'history', mode: 'read-fail', times: 10_000 });
  h.clock.now += 3_600_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const reads = h.aster.calls.history;
  await h.ex.tick();
  const settled = last(h);
  assert.deepEqual([settled.id, settled.state, settled.basis, settled.recovered], [sent.id, 'expired-unverified', 'nonce_expired_unreadable', true]);
  assert.deepEqual([h.aster.calls.history - reads, h.aster.calls.transfer], [2, 1]);
  assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 300_000);
}));

test('任务循环：某配对读取挂起时本轮在时间预算内返回，其余配对在下一轮先处理', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '900' });
  h.aster.openSubAccount(MAIN, FOURTH, { available: '100' });
  h.ex.registerTransferPair({ id: 'z-pair', mainAccountId: MAIN, long: THIRD, short: FOURTH });
  await flip(h, true, 'z-pair');
  await start(h);
  h.aster.inject({ operation: 'balance', mode: 'hang', accountId: LONG });
  const began = performance.now();
  await h.ex.tick();
  assert.ok(performance.now() - began < 2_000, '挂起的读取只占自己的短超时');
  assert.match(pairOf(h).note ?? '', /余额读取失败/);
  assert.deepEqual([h.aster.calls.transfer, pairOf(h, 'z-pair').note, pairOf(h, 'z-pair').balances], [0, null, null], '预算用完，后面的配对留到下一轮');
  await h.ex.tick();
  assert.deepEqual(h.aster.ledger.map(item => item.source), [THIRD]);
  h.aster.releaseHung();
  await run(h, 5_000);
  assert.deepEqual(h.aster.ledger.map(item => item.source), [THIRD, LONG]);
}, { budgets: { transferReadTimeoutMs: 30, transferTickBudgetMs: 10 } }));

test('任务循环：划转处理整体抛错时记事件，本轮任务照常推进，不向外抛', () => withHarness(async h => {
  bindAccounts(h.ex);
  await start(h);
  h.store.db.exec('DROP TABLE transfers');
  const { jobId } = await previewAndConfirm(h);
  assert.equal((await settle(h, jobId)).status, 'completed');
  assert.ok((h.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'transfer-tick-failed'").get() as { n: number }).n > 0);
}));

test('任务循环：注入登记时划转处理抛错，末尾的登记结清仍然执行', async () => {
  const c = await controlledHarness();
  try {
    c.enable();
    takeover(c.h);
    let checks = 0;
    const writer = c.writers.at(-1)!, pending = writer.pendingOperationIds.bind(writer);
    writer.pendingOperationIds = () => { checks++; return pending(); };
    await c.h.ex.tick();
    assert.equal(checks, 2, '每轮开头与末尾各结清一次');
    c.h.store.db.exec('DROP TABLE transfers');
    await c.h.ex.tick();
    assert.equal(checks, 4);
    assert.equal((c.h.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'transfer-tick-failed'").get() as { n: number }).n, 1);
  } finally { c.dispose(); }
});

test('划转：一笔未结清记录损坏时其余划转照常结算，只挡住损坏记录所属的配对；说明写明需人工处置，事件限频，按文档处置后恢复', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '900' });
  h.aster.openSubAccount(MAIN, FOURTH, { available: '100' });
  h.ex.registerTransferPair({ id: 'z-pair', mainAccountId: MAIN, long: THIRD, short: FOURTH });
  await flip(h, true, 'z-pair');
  h.aster.inject({ operation: 'transfer', mode: 'lost-response', times: 2 });
  await start(h);
  await h.ex.tick();
  assert.deepEqual(transfers(h).map(item => [item.pairId, item.state]), [[PAIR, 'unknown'], ['z-pair', 'unknown']]);
  const broken = transfers(h)[0].id;
  h.store.db.prepare("UPDATE transfers SET json = '{' WHERE id = ?").run(broken);
  const failures = () => (h.store.db.prepare("SELECT json FROM events WHERE type = 'transfer-settle-failed' ORDER BY seq").all() as { json: string }[]).map(row => JSON.parse(row.json));
  await run(h, READY_MS);
  assert.deepEqual(transfers(h).map(item => [item.pairId, item.state, item.basis]), [['z-pair', 'confirmed', 'late_receipt_confirmed']]);
  assert.deepEqual([pairOf(h).blocked, pairOf(h).current, pairOf(h, 'z-pair').blocked], ['本配对的未结清划转记录损坏，需人工处置', null, null]);
  assert.deepEqual(failures(), [{ pair: PAIR, transfer: broken, reason: '划转记录无法解析', failures: 1 }]);
  await run(h, 400_000);
  assert.deepEqual(h.aster.ledger.map(item => item.source), [LONG, THIRD], '损坏记录所属配对不再发送');
  assert.equal(failures().length, 2, '116 轮失败只记两条：同一错误每 5 分钟最多一条');
  // The statement of README.md, "人工处置".
  h.store.db.prepare("UPDATE transfers SET state = 'expired-unverified', settled = 1, version = version + 1 WHERE id = ? AND settled = 0").run(broken);
  h.aster.setBalance(LONG, { available: '700', equity: '700' });
  await run(h, 5_000);
  assert.deepEqual([pairOf(h).blocked, last(h).pairId, last(h).state, last(h).amount], [null, PAIR, 'confirmed', '100']);
}));

test('共享写者登记：注入登记后已有的未知划转仍只读结清，之后不新发', async () => {
  const c = await controlledHarness();
  try {
    const sent = await sendUnknown(c.h, 'lost-response', {}, { maxTransfer: '30' });
    c.enable();
    takeover(c.h);
    await run(c.h, last(c.h).readyAt! - c.h.clock.now);
    const settled = last(c.h);
    assert.deepEqual([settled.id, settled.state, settled.basis, settled.recovered], [sent.id, 'confirmed', 'late_receipt_confirmed', true]);
    await run(c.h, 400_000);
    assert.deepEqual([c.h.aster.calls.transfer, transfers(c.h).length], [1, 1]);
    assert.match(pairOf(c.h).blocked ?? '', /共享写者登记/);
  } finally { c.dispose(); }
});

test('预算：划转预算与连接器请求有效期须为正整数，未来容限须为非负整数，时钟容限须小于历史跨度；undefined 覆盖项回落默认值', () => withHarness(async h => {
  const make = (budgets: Partial<Budgets>, aster = h.aster) => () => createExecutor({ store: h.store, connectors: [h.binance, h.bybit], transfers: aster, budgets });
  for (const budgets of [{ transferRetryMs: 0 }, { transferLabelDeferMs: Number.NaN }, { transferHistorySpanMs: 180_000.5 }, { transferReadTimeoutMs: -1 }, { transferTickBudgetMs: Infinity }, { transferRefreshDeferMs: 2 ** 60 },
    { transferBaselineTimeoutMs: 0 }, { transferBalanceMaxAgeMs: 0 }, { transferClockToleranceMs: 180_000 }, { transferHistorySpanMs: 60_000 }, { futureToleranceMs: -1 }, { futureToleranceMs: 0.5 }, { futureToleranceMs: Number.NaN }]) {
    assert.throws(make(budgets), code('budget'), JSON.stringify(budgets));
  }
  for (const requestValidityMs of [Number.NaN, 0, 1.5]) assert.throws(make({}, new SimulatedAster(() => h.clock.now, { requestValidityMs })), code('budget'), String(requestValidityMs));
  const executor = make({ transferRetryMs: undefined, callTimeoutMs: undefined, transferClockToleranceMs: 179_999 })();
  assert.deepEqual([executor.budgets.transferRetryMs, executor.budgets.callTimeoutMs], [DEFAULT_BUDGETS.transferRetryMs, DEFAULT_BUDGETS.callTimeoutMs]);
  assert.equal(make({ futureToleranceMs: 0 })().budgets.futureToleranceMs, 0);
}));

test('划转：未结清记录结算持续出错时记限频事件，本配对与共用账户配对的说明写明出错与连续次数；重启后重新记一条，记录恢复后照常结算', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '300' });
  h.ex.registerTransferPair({ id: 'z-pair', mainAccountId: MAIN, long: LONG, short: THIRD });
  await flip(h, true, 'z-pair');
  const sent = await sendUnknown(h, 'lost-response');
  assert.equal(pairOf(h).blocked, '本配对有未结清的划转');
  h.store.db.prepare("UPDATE transfers SET json = json_set(json, '$.state', 'bogus') WHERE id = ?").run(sent.id);
  const failures = () => (h.store.db.prepare("SELECT json FROM events WHERE type = 'transfer-settle-failed' ORDER BY seq").all() as { json: string }[]).map(row => JSON.parse(row.json));
  await run(h, 10_000);
  assert.equal(pairOf(h).blocked, '本配对的未结清划转结算出错（连续 2 次：未结清划转记录的状态无效），持续出错需人工处置');
  assert.match(pairOf(h, 'z-pair').blocked ?? '', /^共用账户的配对的未结清划转结算出错（连续 2 次：/);
  assert.deepEqual(failures(), [{ pair: PAIR, transfer: sent.id, reason: '未结清划转记录的状态无效', failures: 1 }]);
  await run(h, 290_000);
  assert.equal(failures().length, 1);
  await run(h, 5_000);
  assert.equal(failures().length, 2);
  takeover(h);
  await h.ex.tick();
  assert.equal(failures().length, 3, '限频状态只在内存');
  assert.equal(pairOf(h, 'z-pair').blocked, '接管后有未结清的划转，结清前不发送新划转；其中有划转结算出错（连续 1 次：未结清划转记录的状态无效），持续出错需人工处置');
  h.store.db.prepare("UPDATE transfers SET json = json_set(json, '$.state', 'unknown') WHERE id = ?").run(sent.id);
  await run(h, 5_000);
  assert.deepEqual([last(h).id, last(h).state, last(h).basis, pairOf(h).blocked, h.aster.calls.transfer], [sent.id, 'confirmed', 'late_receipt_confirmed', null, 1]);
}));

test('已回执的划转：按回执结清后，本配对与共用账户的配对都须读到晚于结算时刻的余额才发新请求，且是新请求编号', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '300' });
  h.ex.registerTransferPair({ id: 'z-pair', mainAccountId: MAIN, long: LONG, short: THIRD });
  await flip(h, true, 'z-pair');
  h.aster.balanceAgeMs = 1_000;
  await start(h, { maxTransfer: '30' });
  await h.ex.tick();
  const sent = last(h);
  assert.deepEqual([sent.state, sent.pairId], ['acknowledged', PAIR]);
  h.aster.balanceAgeMs = 0;
  h.aster.inject({ operation: 'balance', mode: 'read-fail', times: 10_000 });
  await run(h, sent.ackAt! + REFRESH_MS - h.clock.now - 5_000);
  assert.equal(last(h).state, 'acknowledged');
  // The refresh that reaches the limit still fails; the planning reads right after it are answered with a snapshot from before the settlement.
  h.aster.clearFaults();
  h.aster.inject({ operation: 'balance', mode: 'read-fail', times: 2 });
  h.aster.balanceAgeMs = 1_000;
  const reads = h.aster.calls.balance;
  await run(h, 5_000);
  const first = last(h);
  assert.deepEqual([first.id, first.state, first.basis, first.balancesRefreshedAt, first.settledAt], [sent.id, 'confirmed', 'acknowledged', null, sent.ackAt! + REFRESH_MS]);
  assert.deepEqual([stored(h).freshAfter, stored(h, 'z-pair').freshAfter], [first.settledAt, first.settledAt]);
  assert.deepEqual([used(h), used(h, 'z-pair')], [[first.receipt], [first.receipt]]);
  assert.deepEqual([h.aster.calls.balance - reads, h.aster.calls.transfer, transfers(h).length], [6, 1, 1], '两个配对的余额都读到了，但快照早于结算时刻');
  for (const id of [PAIR, 'z-pair']) assert.match(pairOf(h, id).note ?? '', /^余额快照早于上一笔划转的结算时刻/, id);
  h.aster.balanceAgeMs = 6_000;
  await run(h, 5_000);
  assert.deepEqual([h.aster.calls.transfer, transfers(h).length], [1, 1]);
  h.aster.balanceAgeMs = 0;
  await run(h, 5_000);
  const mine = transfers(h).filter(item => item.pairId === PAIR);
  assert.deepEqual(mine.map(item => [item.state, item.amount]), [['confirmed', '30'], ['confirmed', '30']]);
  assert.notEqual(mine[1].id, sent.id);
  assert.deepEqual(h.aster.ledger.map(item => [item.source, item.destination]), [[LONG, SHORT], [LONG, SHORT], [LONG, THIRD]]);
}));

test('划转：余额快照接收时刻超前本机时钟超过容限时不规划、不发送，回执后的刷新同样不接受；容限内照常', () => withHarness(async h => {
  h.aster.balanceAgeMs = -1_001;
  await start(h, { maxTransfer: '30', cooldownMs: 1_000 });
  await h.ex.tick();
  assert.deepEqual([h.aster.calls.transfer, transfers(h).length], [0, 0]);
  assert.match(pairOf(h).note ?? '', /^余额快照的接收时刻超前本机时钟 1001 毫秒（容限 1000 毫秒）/);
  h.aster.balanceAgeMs = -1_000;
  await run(h, 5_000);
  assert.deepEqual([last(h).state, h.aster.calls.transfer], ['confirmed', 1]);
  const transfer = h.aster.transfer.bind(h.aster);
  h.aster.transfer = async (...args) => { const ack = await transfer(...args); h.aster.balanceAgeMs = -5_000; return ack; };
  await run(h, 5_000);
  h.aster.transfer = transfer;
  const held = last(h);
  assert.deepEqual([held.state, h.aster.calls.transfer], ['acknowledged', 2]);
  assert.match(held.note!, /余额快照的接收时刻超前本机时钟.*不重发/);
  h.aster.balanceAgeMs = 0;
  await run(h, 5_000);
  const settled = transfers(h).find(item => item.id === held.id)!;
  assert.deepEqual([settled.state, settled.basis, h.aster.ledger.length, new Set(transfers(h).map(item => item.id)).size], ['confirmed', 'acknowledged', h.aster.calls.transfer, h.aster.calls.transfer], '该笔只刷新余额结清，没有重发');
}));

test('未知划转：到期时刻随发送落盘，之后调小预算重启不会提前结算；没有该字段的旧记录按当前预算现算', async () => {
  const smaller = { transferHistorySpanMs: 90_000 };
  await withHarness(async h => {
    const sent = await sendUnknown(h, 'lost-response');
    h.clock.now += 61_000; h.restart({ budgets: smaller });
    assert.equal(h.ex.acquire(), true);
    assert.equal(last(h).readyAt, sent.sentAt! + READY_MS);
    await run(h, sent.sentAt! + READY_MS - h.clock.now - 5_000);
    assert.deepEqual([last(h).state, h.aster.calls.history], ['unknown', 2], '只有发送前基线读过流水');
    await run(h, 5_000);
    assert.deepEqual([last(h).state, last(h).basis, last(h).settledAt], ['confirmed', 'late_receipt_confirmed', sent.sentAt! + READY_MS]);
  });
  await withHarness(async h => {
    const sent = await sendUnknown(h, 'lost-response');
    h.store.db.prepare("UPDATE transfers SET json = json_remove(json, '$.readyAt')").run();
    h.clock.now += 61_000; h.restart({ budgets: smaller });
    assert.equal(h.ex.acquire(), true);
    // The harness call timeout of 50 ms plus the simulated request validity of 120 s, now longer than the history span.
    assert.equal(last(h).readyAt, sent.sentAt! + 120_050);
    await run(h, 60_000);
    assert.deepEqual([last(h).state, last(h).settledAt], ['confirmed', sent.sentAt! + 121_000]);
  });
});

test('任务循环：划转处理持续抛同一错误时，transfer-tick-failed 事件每分钟最多一条', () => withHarness(async h => {
  await start(h);
  h.store.db.exec('DROP TABLE transfers');
  const count = () => (h.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'transfer-tick-failed'").get() as { n: number }).n;
  for (let i = 0; i < 5; i++) await h.ex.tick();
  await run(h, 55_000);
  assert.equal(count(), 1);
  await run(h, 5_000);
  assert.equal(count(), 2);
}));

test('划转：子账户列表缺一侧而余额可读时，发送前的归属校验拒绝，不落盘也不发送', () => withHarness(async h => {
  await start(h);
  h.aster.unlist(SHORT);
  await h.ex.tick();
  assert.deepEqual([h.aster.calls.balance, h.aster.calls['sub-accounts'], h.aster.calls.transfer, transfers(h).length], [2, 2, 0, 0], '余额读到了，归属在列表上被拒');
  assert.equal(pairOf(h).note, '发送前复核失败，未划转：空侧子账户不在主账户的子账户列表中，无法确认归属');
  await flip(h, false);
  await assert.rejects(flip(h, true), code('sub_account_missing'));
  h.aster.unlist(SHORT, false);
  await flip(h, true);
  await run(h, 5_000);
  assert.deepEqual([last(h).state, h.aster.calls.transfer], ['confirmed', 1]);
}));

/** The rollback statements of README.md, "回滚". */
const ROLLBACK_SQL = `
DROP INDEX IF EXISTS transfers_unsettled;
DROP INDEX IF EXISTS transfers_pair;
DROP TABLE IF EXISTS transfers;
DROP TABLE IF EXISTS transfer_pairs;
DELETE FROM commands WHERE kind = 'transfer-enable';
DELETE FROM schema_migrations WHERE version = 3;`;

test('存储：已有 v2 库升级到 v3 只新增划转的两张表与两个索引，原有数据保留；回滚语句退回 v2', () => withHarness(async h => {
  const file = h.file.replace(/executor\.sqlite$/, 'v2.sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sql_sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, 2)) {
    old.exec(migration.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, 0)').run(migration.version, migration.name, sqlHash(migration.sql));
  }
  old.prepare("INSERT INTO events(job_id, type, at, json) VALUES (NULL, 'legacy', 1, '{}')").run();
  old.prepare("INSERT INTO accounts VALUES ('binance:simulated:BN1001', 'binance', 'simulated', 'BN1001', 'standard', 1, 1)").run();
  const names = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const before = names(old);
  old.close();
  const added = ['transfer_pairs', 'transfers', 'transfers_pair', 'transfers_unsettled'];
  const store = openStore(file);
  try {
    // Migration 4 (ADL) has its own upgrade test; this one checks migration 3 alone.
    store.db.exec(ADL_ROLLBACK_SQL);
    assert.equal(store.schemaVersion(), 3);
    assert.deepEqual(names(store.db), [...before, ...added].sort());
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'legacy'").get() as { n: number }).n, 1);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n, 1);
    store.db.prepare("INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES ('r1', 'transfer-enable', 'd', 's', 'sim-pair', 1)").run();
    store.db.exec(ROLLBACK_SQL);
    assert.equal(store.schemaVersion(), 2);
    assert.deepEqual(names(store.db), before);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM commands').get() as { n: number }).n, 0);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'legacy'").get() as { n: number }).n, 1);
  } finally { store.close(); }
}));

test('恢复：落盘后中断的划转所属配对记录损坏时，接管照常完成并把该笔记为未发送；重新登记损坏的配对被明确拒绝', () => withHarness(async h => {
  await start(h);
  const tx = h.store.tx;
  let armed = true;
  h.store.tx = (operation => {
    if (armed && h.store.db.prepare("SELECT 1 FROM transfers WHERE state = 'prepared'").get()) { armed = false; throw new Error('模拟磁盘写入失败'); }
    return tx(operation);
  }) as typeof tx;
  await h.ex.tick();
  assert.equal(last(h).state, 'prepared');
  h.store.db.prepare("UPDATE transfer_pairs SET json = '{' WHERE id = ?").run(PAIR);
  takeover(h);
  assert.deepEqual([last(h).state, h.aster.calls.transfer, h.ex.corruptTransferPairs()], ['not-sent', 0, [PAIR]]);
  assert.throws(() => h.ex.registerTransferPair(SIM_TRANSFER_PAIR), code('pair_corrupt'));
  await run(h, 10_000);
  assert.equal(h.aster.calls.transfer, 0);
}));

test('已用流水：共用账户但自己不发送的配对也按时间窗口清理，不随另一配对的划转无限增长', () => withHarness(async h => {
  h.aster.openSubAccount(MAIN, THIRD, { available: '300' });
  h.ex.registerTransferPair({ id: 'z-pair', mainAccountId: MAIN, long: LONG, short: THIRD });
  h.aster.setBalance(LONG, { available: '100000', equity: '100000' });
  await start(h, { maxTransfer: '30', cooldownMs: 5_000, checkIntervalMs: 5_000 });
  await run(h, 400_000);
  const sent = h.aster.ledger.length, kept = stored(h, 'z-pair').usedReceipts;
  assert.ok(sent > 60, String(sent));
  assert.ok(kept.length < sent && kept.every(item => item.at + 300_000 > h.clock.now), `${kept.length}/${sent}`);
  assert.equal(kept.at(-1)!.tranId, h.aster.ledger.at(-1)!.tranId);
  assert.deepEqual(kept.map(item => item.tranId), h.aster.ledger.slice(-kept.length).map(item => item.tranId));
}));

test('未知划转：本次已到账，转出侧另有一笔同额转出给别的账户时，两侧候选 2/1 笔，不确认，记为归属歧义', () => withHarness(async h => {
  await sendUnknown(h, 'lost-response');
  h.advance(20_000);
  h.aster.addReceipt(LONG, { direction: 'out', amount: '100' });
  await run(h, READY_MS - 20_000);
  const settled = last(h);
  assert.deepEqual([settled.state, settled.basis, settled.receipt, h.aster.calls.transfer], ['expired-unverified', 'nonce_expired_ambiguous_receipt', null, 1]);
  assert.match(settled.labelNote!, /同额候选流水 2\/1 笔/);
  assert.equal(pairOf(h).cooldownUntil, settled.settledAt! + 300_000);
}));

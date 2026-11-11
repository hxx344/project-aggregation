// Plan 2.4a: jobs, margin transfers and ADL incidents run as three passes the
// entry schedules apart, so a venue call that hangs in one of them holds up
// only that pass. tick() still runs one pass of each in turn. Transfers and ADL
// of one pair still never have a send on the wire at the same time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SIM_TRANSFER_PAIR } from '../src/simulation.ts';
import { SESSION, bindAccounts, createHarness, previewAndConfirm, type Harness } from './harness.ts';

const { id: PAIR, long: LONG } = SIM_TRANSFER_PAIR;
const SYMBOL = 'BTCUSDT';
/** A hung read costs a pass this much real time before its own timeout ends it. */
const HANG_MS = 5_000;

async function withLoops(run: (h: Harness) => Promise<void>) {
  const h = createHarness({ budgets: { callTimeoutMs: HANG_MS, transferReadTimeoutMs: HANG_MS, adlReadTimeoutMs: HANG_MS, adlOrderTimeoutMs: HANG_MS } });
  try {
    bindAccounts(h.ex);
    h.ex.registerTransferPair(SIM_TRANSFER_PAIR);
    // The first ADL pass sets the scan start, as the entry's first pass does.
    await h.ex.tickAdl();
    await run(h);
  } finally { h.aster.releaseHung(); h.asterTrading.releaseHung(); h.dispose(); }
}
const enableTransfers = (h: Harness) => h.ex.setTransferEnabled({ pairId: PAIR, enabled: true, requestId: randomUUID() }, SESSION);
/** Resolves to true once the promise has settled, without waiting for it. */
const watch = (promise: Promise<unknown>) => { const state = { settled: false }; void promise.then(() => { state.settled = true; }, () => { state.settled = true; }); return state; };
async function finishJob(h: Harness, jobId: string) {
  for (let i = 0; i < 20; i++) {
    await h.ex.tickJobs();
    const view = h.ex.jobView(jobId);
    if (['completed', 'failed', 'stopped', 'attention'].includes(view.status)) return view;
    h.advance(1_000);
  }
  return h.ex.jobView(jobId);
}
const adlIncident = (h: Harness) => h.ex.adlPairs().find(item => item.pairId === PAIR)!.incident;
const transferNote = (h: Harness) => h.ex.transferPairs().find(pair => pair.id === PAIR)!.note ?? '';
/** Waits in real time, as the simulated venues answer on the event loop, for a state reached part-way through a pass. */
async function until(check: () => boolean, label: string) {
  for (const began = performance.now(); !check(); await new Promise(resolve => setTimeout(resolve, 1))) {
    if (performance.now() - began > 2_000) assert.fail(`等待超时：${label}`);
  }
}
/** Settles within the limit or fails, instead of hanging the run. */
const within = <T>(promise: Promise<T>, label: string, ms = 2_000) => Promise.race([promise, new Promise<never>((_resolve, fail) => setTimeout(() => fail(new Error(`超时：${label}`)), ms).unref())]);

test('循环拆分：划转读取挂起时，两腿任务照常完成、ADL 照常减仓；同一循环重复调用并入在途轮次', () => withLoops(async h => {
  await enableTransfers(h);
  h.aster.inject({ operation: 'balance', mode: 'hang', accountId: LONG });
  const began = performance.now();
  const transferPass = h.ex.tickTransfers();
  assert.equal(h.ex.tickTransfers(), transferPass, '在途轮次被复用，不并发第二轮');
  const transferState = watch(transferPass);

  const { jobId } = await previewAndConfirm(h);
  assert.equal((await finishJob(h, jobId)).status, 'completed');
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.01');
  await h.ex.tickAdl();
  assert.deepEqual(adlIncident(h)!.batches.map(batch => batch.state), ['done'], 'ADL 不等划转');
  assert.equal(transferState.settled, false, '划转轮次仍挂在读取上');
  assert.ok(performance.now() - began < HANG_MS, '以上都在划转读取超时之前完成');

  // Released, the read answers and the pass goes on to plan and send.
  h.aster.releaseHung();
  await transferPass;
  assert.equal(h.aster.calls.transfer, 1);
}));

test('循环拆分：ADL 账户读取挂起时，两腿任务照常完成、划转照常发送', () => withLoops(async h => {
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.01');
  h.asterTrading.inject({ operation: 'account', mode: 'hang' });
  const began = performance.now();
  const adlState = watch(h.ex.tickAdl());

  const { jobId } = await previewAndConfirm(h);
  assert.equal((await finishJob(h, jobId)).status, 'completed');
  await enableTransfers(h);
  await h.ex.tickTransfers();
  assert.deepEqual([h.aster.calls.transfer, h.ex.recentTransfers(1)[0]?.state], [1, 'confirmed'], '划转不等 ADL');
  assert.equal(adlState.settled, false, 'ADL 轮次仍挂在账户读取上');
  assert.ok(performance.now() - began < HANG_MS, '以上都在 ADL 读取超时之前完成');
  assert.equal(h.asterTrading.arrived.place, 0);
}));

test('循环拆分：tick() 依次跑完三个循环各一轮，与各循环的在途轮次合并', () => withLoops(async h => {
  await enableTransfers(h);
  h.aster.inject({ operation: 'balance', mode: 'hang', accountId: LONG });
  const transferPass = h.ex.tickTransfers();
  const pass = h.ex.tick(), all = watch(pass);
  await h.ex.tickJobs();
  assert.equal(all.settled, false, 'tick() 等在途的划转轮次结束');
  h.aster.releaseHung();
  await within(transferPass, '划转轮次');
  await within(pass, 'tick()');
}));

test('同配对互斥：ADL 减仓单在途时划转本轮不发，减仓单有结果后照常划转', () => withLoops(async h => {
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.01');
  h.asterTrading.inject({ operation: 'place', mode: 'hang' });
  const adlPass = h.ex.tickAdl();
  await until(() => adlIncident(h)?.batches[0]?.state === 'sending', '减仓单发送中');
  await enableTransfers(h);
  await h.ex.tickTransfers();
  assert.equal(h.aster.calls.transfer, 0);
  assert.match(transferNote(h), /ADL 减仓单正在发送或挂单，本轮不划转/);

  // Released, the send answers nothing usable: the batch turns unknown and is no longer on the wire.
  h.asterTrading.releaseHung();
  await within(adlPass, 'ADL 轮次');
  assert.equal(adlIncident(h)!.batches[0].state, 'unknown');
  h.advance(5_000);
  await h.ex.tickTransfers();
  assert.equal(h.aster.calls.transfer, 1);
}));

test('同配对互斥：划转发送在途时 ADL 受阻不下单，划转有回执后一秒内继续减仓', () => withLoops(async h => {
  await enableTransfers(h);
  h.aster.inject({ operation: 'transfer', mode: 'hang-after-apply' });
  const transferPass = h.ex.tickTransfers();
  await until(() => h.ex.recentTransfers(1)[0]?.state === 'sending', '划转发送中');
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.01');
  await h.ex.tickAdl();
  const held = adlIncident(h)!;
  assert.deepEqual([held.status, held.reason, held.batches.length, h.asterTrading.arrived.place], ['blocked', '配对的保证金划转正在发送，等划转有结果后再减仓', 0, 0]);

  h.aster.releaseHung();
  await within(transferPass, '划转轮次');
  assert.notEqual(h.ex.recentTransfers(1)[0].state, 'sending');
  h.advance(1_000);
  await h.ex.tickAdl();
  assert.deepEqual(adlIncident(h)!.batches.map(batch => batch.state), ['done']);
}));

test('同配对互斥：ADL 读取现场途中划转开始发送，落盘前复查后不下单，划转有回执后照常减仓', () => withLoops(async h => {
  await enableTransfers(h);
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.01');
  // Only the scene read calls account, so the gate holds the pass after its first check and before persisting.
  const sim = h.asterTrading, read = sim.account.bind(sim);
  let open!: () => void, reading = 0;
  const gate = new Promise<void>(resolve => { open = resolve; });
  sim.account = async (...args) => { reading++; await gate; return read(...args); };
  const adlPass = h.ex.tickAdl();
  let transferPass: Promise<void>;
  // A failed wait still opens the gate, so the held pass does not outlive the test.
  try {
    await until(() => reading > 0, 'ADL 读取现场');
    h.aster.inject({ operation: 'transfer', mode: 'hang-after-apply' });
    transferPass = h.ex.tickTransfers();
    await until(() => h.ex.recentTransfers(1)[0]?.state === 'sending', '划转发送中');
  } finally { open(); sim.account = read; }
  await within(adlPass, 'ADL 轮次');
  assert.deepEqual([adlIncident(h)!.batches.length, sim.arrived.place], [0, 0]);

  h.aster.releaseHung();
  await within(transferPass, '划转轮次');
  h.advance(10_000);
  await h.ex.tickAdl();
  assert.deepEqual(adlIncident(h)!.batches.map(batch => batch.state), ['done']);
}));

test('同配对互斥：划转读取余额途中 ADL 开始发送减仓单，落盘前复查后不划转', () => withLoops(async h => {
  await enableTransfers(h);
  h.aster.inject({ operation: 'balance', mode: 'hang', accountId: LONG });
  const transferPass = h.ex.tickTransfers();
  await until(() => h.aster.calls.balance > 0, '划转读取余额');
  h.asterTrading.adl(LONG, SYMBOL, 'LONG', '0.01');
  h.asterTrading.inject({ operation: 'place', mode: 'hang' });
  const adlPass = h.ex.tickAdl();
  await until(() => adlIncident(h)?.batches[0]?.state === 'sending', '减仓单发送中');
  h.aster.releaseHung();
  await within(transferPass, '划转轮次');
  assert.equal(h.aster.calls.transfer, 0);
  assert.match(transferNote(h), /ADL 减仓单正在发送或挂单，本次不划转/);
  h.asterTrading.releaseHung();
  await within(adlPass, 'ADL 轮次');
}));

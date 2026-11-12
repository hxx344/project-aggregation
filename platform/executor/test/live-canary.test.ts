// The workbench-driven oil canary (src/live/canary.ts) against the stand-in venues: one step per prepareCanary call, as the
// workbench runs one process per step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor } from '../src/executor.ts';
import type { AccountBinding } from '../src/contracts.ts';
import { CanaryRefusal, parseCanaryParams, prepareCanary, type CanaryDeps, type CanaryParams } from '../src/live/canary.ts';
import { createLiveConnectors, preflightLive } from '../src/live/setup.ts';
import { openStore } from '../src/store.ts';
import { FakeBinance, KEY as BINANCE_KEY, SECRET as BINANCE_SECRET, binding as binanceBinding } from './live-fake-binance.ts';
import { FakeBybit, KEY as BYBIT_KEY, SECRET as BYBIT_SECRET, binding as bybitBinding } from './live-fake-bybit.ts';

const ACCOUNTS: AccountBinding[] = [binanceBinding(), bybitBinding()];
const KEYS = { binance: { apiKey: BINANCE_KEY, apiSecret: BINANCE_SECRET }, bybit: { apiKey: BYBIT_KEY, apiSecret: BYBIT_SECRET } };
const RAW = { step: 'open', symbol: 'CLUSDT', lead: 'binance', leadSide: 'long', leadOrder: 'market', quantity: '1', perJob: '150', totalOpen: '400', timeoutS: '60' };
const params = (overrides: Record<string, string | undefined> = {}): CanaryParams => parseCanaryParams({ ...RAW, ...overrides });

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-canary-'));
  const binance = new FakeBinance(), bybit = new FakeBybit();
  binance.fillAll = bybit.fillAll = true;
  const clock = { now: binance.clock };
  const sync = () => { binance.clock = bybit.clock = clock.now; };
  const connectors = createLiveConnectors({ accounts: ACCOUNTS }, new Map(Object.entries(KEYS)) as never,
    { fetchImpl: (url, init) => (new URL(url).hostname.endsWith('bybit.com') ? bybit : binance).fetch(url, init), now: () => clock.now });
  const lines: string[] = [];
  let stop = false, onWait: () => void = () => undefined;
  const deps: CanaryDeps = { dir, accounts: ACCOUNTS, connectors, log: line => lines.push(line), now: () => clock.now,
    wait: async ms => { clock.now += ms; sync(); onWait(); }, stopRequested: () => stop };
  const writes = () => binance.calls.filter(call => call.method === 'POST').length + bybit.calls.filter(call => call.method === 'POST').length;
  return { dir, binance, bybit, clock, sync, connectors, deps, lines, writes, setStop: (value: boolean) => { stop = value; }, onWait: (fn: () => void) => { onWait = fn; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
/** The workbench now uses another Binance account. */
function moved(w: ReturnType<typeof world>): CanaryDeps {
  const accounts = [{ ...ACCOUNTS[0], accountId: '777000111' }, ACCOUNTS[1]];
  const connectors = createLiveConnectors({ accounts }, new Map(Object.entries(KEYS)) as never,
    { fetchImpl: (url, init) => (new URL(url).hostname.endsWith('bybit.com') ? w.bybit : w.binance).fetch(url, init), now: () => w.clock.now });
  return { ...w.deps, accounts, connectors };
}
async function run(w: ReturnType<typeof world>, p: CanaryParams) {
  const prepared = await prepareCanary(p, w.deps);
  try { return { prepared, outcome: prepared.phrase ? await prepared.execute() : null }; } finally { prepared.close(); }
}
async function preview(w: ReturnType<typeof world>, p: CanaryParams) {
  const prepared = await prepareCanary(p, w.deps);
  prepared.close();
  return prepared;
}

test('金丝雀参数：单笔 ≤200、累计 ≤500 USDT 且单笔不大于累计；追价只限 Bybit 首腿；执行时长 30–600 秒', () => {
  assert.deepEqual(params({ quantity: '1.50', maxSlippageBps: '40' }), { ...params(), quantity: '1.5', maxSlippageBps: 40 });
  for (const [overrides, pattern] of [
    [{ perJob: '200.01' }, /单笔名义金额上限不得超过 200/], [{ totalOpen: '501' }, /累计开仓名义金额上限不得超过 500/], [{ perJob: '300', totalOpen: '250' }, /不得超过 200/],
    [{ perJob: '150', totalOpen: '100' }, /单笔名义金额上限不得大于累计开仓上限/], [{ leadOrder: 'chase' }, /只有 Bybit 首腿可以用原生追价/], [{ timeoutS: '29' }, /30 至 600/],
    [{ timeoutS: '601' }, /30 至 600/], [{ symbol: 'SKHYUSDT' }, /合约须为/], [{ quantity: '0' }, /每腿数量须为正/], [{ step: 'adl' }, /步骤须为/], [{ maxSlippageBps: '201' }, /1 至 200/],
    [{ strategy: 'release' }, /只在「收尾」里做/], [{ step: 'settle', strategy: 'adopt' }, /须填写策略编号/], [{ step: 'settle', strategyId: 'abc' }, /只有认领追价策略时填写/],
    [{ step: 'settle', strategy: 'adopt', strategyId: 'a b' }, /策略编号只能是/], [{ step: 'settle', strategy: 'keep' }, /追价策略处理方式须为/],
  ] as [Record<string, string>, RegExp][]) assert.throws(() => params(overrides), (error: unknown) => error instanceof CanaryRefusal && pattern.test(error.message), JSON.stringify(overrides));
});

test('金丝雀检查：只读；新目录记为实盘并建独立实盘库；账户持仓与金丝雀记录不一致、该合约有挂单都列为待处理', async () => {
  const w = world();
  try {
    await preflightLive({ accounts: ACCOUNTS }, w.connectors);
    const clean = await preview(w, params({ step: 'check' }));
    assert.equal(clean.phrase, null);
    assert.match(clean.summary, /^检查通过/);
    assert.equal(readFileSync(join(w.dir, 'environment'), 'utf8'), 'mainnet\n');
    assert.ok(existsSync(join(w.dir, 'executor-live.sqlite')) && !existsSync(join(w.dir, 'executor.sqlite')));
    w.binance.net.set('CLUSDT', 2);
    const dirty = await preview(w, params({ step: 'check' }));
    assert.match(dirty.summary, /Binance 账户持仓 2 与金丝雀记录 0 不一致/);
    assert.ok(w.lines.every(line => !line.includes(ACCOUNTS[0].accountId) && !line.includes(ACCOUNTS[1].accountId)), '日志只带账户编号末四位');
    await assert.rejects(clean.execute(), CanaryRefusal);
    assert.equal(w.writes(), 0);
  } finally { w.cleanup(); }
});

test('金丝雀数据目录：模拟用过的目录拒绝；另一个进程持有租约时等到租约过期仍不放手就拒绝', async () => {
  const w = world();
  try {
    writeFileSync(join(w.dir, 'environment'), 'simulated\n');
    await assert.rejects(prepareCanary(params({ step: 'check' }), w.deps), /数据目录已用于模拟/);
    rmSync(join(w.dir, 'environment'));
    const holder = createExecutor({ store: openStore(join(w.dir, 'executor-live.sqlite')), connectors: w.connectors, environment: 'mainnet', notionalLimits: { perJob: '150', totalOpen: '400' }, now: () => w.clock.now });
    assert.ok(holder.acquire());
    w.onWait(() => { if (w.clock.now < 1_800_000_030_000) holder.acquire(); });
    await assert.rejects(prepareCanary(params({ step: 'check' }), w.deps), /另一个进程持有金丝雀执行器的写入租约/);
  } finally { w.cleanup(); }
});

test('金丝雀开仓与平仓：预览不发单并给出确认短语；实盘跑到终态、计入累计上限；平仓只平金丝雀自己的仓位，Bybit 追价首腿', async () => {
  const w = world();
  try {
    const first = await preview(w, params());
    assert.match(first.phrase!, /^oil-canary-open-CLUSDT-binance-long-market-1-[0-9a-f]{10}$/);
    assert.equal(w.writes(), 0, '预览不发任何写请求');
    assert.equal((await preview(w, params())).phrase, first.phrase, '同一组参数与账户的短语不变');
    assert.notEqual((await preview(w, params({ quantity: '2' }))).phrase, first.phrase);

    const opened = await run(w, params());
    assert.equal(opened.outcome?.settled, true, opened.outcome?.summary);
    assert.match(opened.outcome!.summary, /^开仓完成/);
    assert.deepEqual([w.binance.net.get('CLUSDT'), w.bybit.net.get('CLUSDT')], [1, -1]);
    const used = (opened.outcome!.findings as { openUsedAfter: string }).openUsedAfter;
    assert.ok(Number(used) > 0 && Number(used) <= 150, used);

    // The account also holds 3 more of the old system's long on Binance: the canary closes only its own 1.
    w.binance.net.set('CLUSDT', 4);
    await assert.rejects(prepareCanary(params({ step: 'close', quantity: '2' }), w.deps), /平仓数量 2 超过金丝雀自有仓位 1/);
    const bybitLead = params({ step: 'close', lead: 'bybit', leadOrder: 'chase' });
    const closePreview = await preview(w, bybitLead);
    assert.match(closePreview.phrase!, /^oil-canary-close-CLUSDT-bybit-short-chase-1-/, '平仓方向取自金丝雀持仓，不取表单');
    w.onWait(() => { if (w.bybit.strategies.some(row => row.status === 2)) w.bybit.finishChases(); });
    const closed = await run(w, bybitLead);
    assert.equal(closed.outcome?.settled, true, closed.outcome?.summary);
    assert.deepEqual([w.binance.net.get('CLUSDT'), w.bybit.net.get('CLUSDT')], [3, 0]);
    assert.match(closed.outcome!.summary, /金丝雀自有持仓 Binance 0、Bybit 0/);
    await assert.rejects(prepareCanary(params({ step: 'close' }), w.deps), /没有可平的 CLUSDT 仓位/);
    const check = await preview(w, params({ step: 'check' }));
    assert.match(check.summary, /Binance 账户持仓 3 与金丝雀记录 0 不一致/);
  } finally { w.cleanup(); }
});

test('金丝雀停止：确认前收到停止请求不发单；运行中收到停止请求转交执行器收尾', async () => {
  const w = world();
  try {
    w.setStop(true);
    const prepared = await prepareCanary(params(), w.deps);
    try { await assert.rejects(prepared.execute(), /收到停止请求，未发送/); } finally { prepared.close(); }
    assert.equal(w.writes(), 0);

    w.setStop(false);
    const chase = params({ lead: 'bybit', leadSide: 'long', leadOrder: 'chase', timeoutS: '30' });
    const running = await prepareCanary(chase, w.deps);
    try {
      w.onWait(() => w.setStop(true));
      const outcome = await running.execute();
      assert.equal(outcome.sent, true);
      assert.ok(w.lines.includes('已请求停止任务，等待执行器收尾'), w.lines.join('\n'));
      assert.equal(w.bybit.count('POST /v5/strategy/create'), 1);
    } finally { running.close(); }
  } finally { w.cleanup(); }
});

test('金丝雀收尾：上一进程留下未结束任务时开平仓拒绝；收尾按短语把任务核对到终态（首腿不再新发，只补对冲腿）', async () => {
  const w = world();
  try {
    assert.equal((await preview(w, params({ step: 'settle' }))).phrase, null);
    // A previous process confirmed a job and died before its first tick.
    const store = openStore(join(w.dir, 'executor-live.sqlite'));
    const ex = createExecutor({ store, connectors: w.connectors, environment: 'mainnet', notionalLimits: { perJob: '150', totalOpen: '400' }, now: () => w.clock.now });
    assert.ok(ex.acquire());
    for (const account of ACCOUNTS) ex.registerAccount(account);
    const intent = { market: 'oil', preset: 'cross-exchange', symbol: 'CLUSDT', action: 'open', timeoutMs: 60_000, legs: [{ venue: 'binance', side: 'long', quantity: '1', orderType: 'market' }, { venue: 'bybit', side: 'short', quantity: '1', orderType: 'market' }] };
    const made = await ex.preview(intent, 'old-process');
    const { job } = ex.confirm({ previewId: made.id, requestId: randomUUID(), confirmLive: true }, 'old-process');
    await ex.tick();
    assert.equal(ex.jobView(job.id).status, 'running');
    ex.close(); store.close();
    const leadSent = w.binance.count('POST /fapi/v1/order'), hedgeSent = w.bybit.count('POST /v5/order/create');
    assert.deepEqual([leadSent, hedgeSent], [1, 0]);

    await assert.rejects(prepareCanary(params(), w.deps), /有 1 个未结束或待人工确认的金丝雀任务，请先做「收尾」/);
    const check = await preview(w, params({ step: 'check' }));
    assert.match(check.summary, /请先做「收尾」/);
    const settle = await prepareCanary(params({ step: 'settle' }), w.deps);
    try {
      assert.match(settle.phrase!, /^oil-canary-settle-1-[0-9a-f]{10}$/);
      const outcome = await settle.execute();
      assert.equal(outcome.settled, true, outcome.summary);
      assert.match(outcome.summary, /^收尾完成/);
    } finally { settle.close(); }
    assert.equal(w.binance.count('POST /fapi/v1/order'), leadSent, '接管后首腿不再新发');
    assert.equal(w.bybit.count('POST /v5/order/create'), 1, '首腿已成交部分补发对冲腿');
    assert.deepEqual([w.binance.net.get('CLUSDT'), w.bybit.net.get('CLUSDT')], [1, -1]);
    assert.equal((await preview(w, params({ step: 'settle' }))).phrase, null);
  } finally { w.cleanup(); }
});

test('金丝雀换账户与手工平仓：自有持仓只算当前绑定账户的腿；账户实际持仓不足以平金丝雀记录时拒绝平仓', async () => {
  const w = world();
  try {
    assert.equal((await run(w, params())).outcome?.settled, true);
    // Someone closed the Binance side by hand: the record says long 1, the account holds nothing.
    w.binance.net.set('CLUSDT', 0);
    await assert.rejects(prepareCanary(params({ step: 'close' }), w.deps), /Binance 账户持仓 0 不足以按金丝雀记录 1 平 1/);
    w.binance.net.set('CLUSDT', 1);
    // The workbench now uses another Binance account: the canary's long there is no longer its to close.
    const check = await prepareCanary(params({ step: 'check' }), moved(w));
    check.close();
    assert.match(check.summary, /有 1 个 CLUSDT 金丝雀任务做在此前绑定的执行账户上/);
    assert.deepEqual((check.findings as { canaryNet: unknown }).canaryNet, { binance: '0', bybit: '-1' });
    await assert.rejects(prepareCanary(params({ step: 'close' }), moved(w)), /金丝雀在 Binance 没有可平的 CLUSDT 仓位/);
    assert.ok(w.lines.every(line => !line.includes('777000111')));
  } finally { w.cleanup(); }
});

test('金丝雀收尾：Bybit 追价首腿创建无回应停在待人工确认；观察窗内拒绝确认，之后自动核对未创建再确认；也可强制释放后再收尾', async () => {
  const w = world();
  try {
    const chase = params({ lead: 'bybit', leadOrder: 'chase', timeoutS: '30' });
    const unanswered = async () => {
      w.bybit.scripted.set('POST /v5/strategy/create', [() => { throw new TypeError('fetch failed'); }]);
      const opened = await run(w, chase);
      assert.deepEqual([opened.outcome?.sent, opened.outcome?.settled], [true, false], opened.outcome?.summary);
      const check = (await preview(w, params({ step: 'check' }))).findings as { attention: { strategyPending: boolean }[] };
      assert.deepEqual(check.attention.map(job => job.strategyPending), [true]);
      await assert.rejects(prepareCanary(params(), w.deps), /请先做「收尾」/);
    };
    await unanswered();
    const early = await run(w, params({ step: 'settle' }));
    assert.equal(early.outcome?.settled, false);
    assert.match(early.outcome!.summary, /仍可能送达交易所/);
    assert.doesNotMatch(early.outcome!.summary, /可在 Bybit 查到策略编号/, '观察窗内只需等待，不提示强制释放');
    w.clock.now += 125_000; w.sync();
    const late = await run(w, params({ step: 'settle' }));
    assert.equal(late.outcome?.settled, true, late.outcome?.summary);
    assert.equal((await preview(w, params({ step: 'settle' }))).phrase, null);

    await unanswered();
    // The old Binance binding holds the unacknowledged job, so the canary cannot move to another account yet.
    await assert.rejects(prepareCanary(params({ step: 'check' }), moved(w)), /请先在交易中心换回原账户/);
    const unknownId = await run(w, params({ step: 'settle', strategy: 'adopt', strategyId: 'x1' }));
    assert.deepEqual([unknownId.outcome?.sent, unknownId.outcome?.settled], [true, false], '认领可能撤策略，按已发送报告');
    assert.match(unknownId.outcome!.summary, /查无该策略编号/);
    const released = await run(w, params({ step: 'settle', strategy: 'release' }));
    assert.equal(released.outcome?.settled, false);
    assert.match(released.outcome!.summary, /已强制释放追价策略，到交易所处理后再做一次收尾/);
    const after = await run(w, params({ step: 'settle' }));
    assert.equal(after.outcome?.settled, true, after.outcome?.summary);
    assert.equal(w.bybit.count('POST /v5/strategy/create'), 2, '收尾从不重发追价');
    assert.equal((await preview(w, params({ step: 'settle', strategy: 'release' }))).phrase, null, '没有待收尾任务时什么都不做');
  } finally { w.cleanup(); }
});

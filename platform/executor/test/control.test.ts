// Shared account-writer registry, exercised against the workbench's real
// implementation in a throwaway directory outside the executor's data dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ContractError } from '../src/contracts.ts';
import { createExecutor } from '../src/executor.ts';
import type { AccountWriterPort, RegistryIdentity } from '../src/account-control.ts';
import { SESSION, createHarness, openIntent, previewAndConfirm, settle, type Harness } from './harness.ts';
import type { Budgets } from '../src/executor.ts';

interface Snapshot { accounts: { authority: string; environment: string; moduleId: string; state: string }[]; operations: { moduleId: string; state: string; count: number }[] }
type TestWriter = AccountWriterPort & { snapshot(): Snapshot; close(): void; pid: number };
const { createAccountWriter } = await import(new URL('../../../server/execution/account-writer.mjs', import.meta.url).href) as { createAccountWriter(options: Record<string, unknown>): TestWriter };

const ACCOUNTS = { binance: '10010001', bybit: '20020002' } as const;
const identity = (venue: 'binance' | 'bybit'): RegistryIdentity => ({ authority: venue, environment: 'testnet', accountId: ACCOUNTS[venue] });
const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;

interface Registry {
  file: string;
  alive: Set<number>;
  writers: TestWriter[];
  /** When false, a restart leaves the previous process alive, as if it still ran. */
  killOnRestart: boolean;
  open(moduleId: string, clock: { now: number }): TestWriter;
  current(): TestWriter;
  states(): Record<string, string>;
}
function createRegistry(): Registry & { dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'pa-control-')), file = join(dir, 'execution-control.sqlite');
  let nextPid = 40_000;
  const registry = {
    file, alive: new Set<number>(), writers: [] as TestWriter[], killOnRestart: true,
    open(moduleId: string, clock: { now: number }) {
      const pid = nextPid++;
      registry.alive.add(pid);
      const writer = createAccountWriter({ databasePath: file, moduleId, runtimeId: randomUUID(), pid, now: () => clock.now, processAlive: (value: number) => registry.alive.has(value) });
      writer.pid = pid;
      registry.writers.push(writer);
      return writer;
    },
    current() { return registry.writers.filter(writer => !writer.closed).at(-1) as TestWriter; },
    states() {
      const db = new DatabaseSync(file, { readOnly: true });
      try { return Object.fromEntries((db.prepare('SELECT operation_id, state FROM aw_operations ORDER BY created_at, operation_id').all() as { operation_id: string; state: string }[]).map(row => [row.operation_id, row.state])); }
      finally { db.close(); }
    },
    dispose() {
      for (const writer of registry.writers) try { writer.close(); } catch { /* retired writers may refuse */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return registry;
}

function bindNumeric(h: Harness): void {
  h.binance.openAccount(ACCOUNTS.binance, { CLUSDT: 'one-way', BZUSDT: 'one-way', ANTHROPICUSDT: 'one-way' });
  h.bybit.openAccount(ACCOUNTS.bybit, { CLUSDT: 'one-way', BZUSDT: 'one-way' });
  h.ex.registerAccount({ venue: 'binance', environment: 'simulated', accountId: ACCOUNTS.binance, accountMode: 'standard', credentialVersion: 1 });
  h.ex.registerAccount({ venue: 'bybit', environment: 'simulated', accountId: ACCOUNTS.bybit, accountMode: 'unified', credentialVersion: 1 });
}

type Wrap = (writer: TestWriter) => AccountWriterPort;
async function withControl(run: (h: Harness, registry: Registry) => Promise<void>, { budgets = {}, numeric = true, wrap }: { budgets?: Partial<Budgets>; numeric?: boolean; wrap?: Wrap } = {}) {
  const registry = createRegistry();
  const h = createHarness({
    budgets,
    control: clock => {
      // A restart is a new process: the previous one is gone unless the test says it still runs.
      const previous = registry.current();
      if (previous && registry.killOnRestart) registry.alive.delete(previous.pid);
      const writer = registry.open('platform', clock);
      return { writer: wrap ? wrap(writer) : writer, environment: 'testnet' };
    },
  });
  try {
    if (numeric) bindNumeric(h);
    await run(h, registry);
  } finally { h.dispose(); registry.dispose(); }
}
const takeover = (h: Harness) => { h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true); };
const leg = (h: Harness, jobId: string, index: 0 | 1) => h.ex.jobView(jobId).legs[index];

test('写者登记：两腿各在自己的账户登记建单，结果落盘后登记为已确认，账户归 platform 模块', () => withControl(async (h, registry) => {
  const { jobId } = await previewAndConfirm(h);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  const lead = leg(h, jobId, 0).operation?.clientOrderId, hedge = leg(h, jobId, 1).operation?.clientOrderId;
  assert.deepEqual(registry.states(), { [`platform:create:${lead}`]: 'confirmed', [`platform:create:${hedge}`]: 'confirmed' });
  assert.deepEqual(registry.current().snapshot().accounts.map(row => [row.authority, row.environment, row.moduleId, row.state]),
    [['binance', 'testnet', 'platform', 'owned'], ['bybit', 'testnet', 'platform', 'owned']]);
}));

test('写者登记：只运行不交易时不认领任何账户（认领会永久钉选账户归属）', () => withControl(async (h, registry) => {
  for (let i = 0; i < 3; i++) { await h.ex.tick(); h.advance(1_000); }
  assert.deepEqual(registry.current().snapshot().accounts, []);
}));

test('写者登记：对冲账户已被其他模块认领时，首腿也不发送，任务失败', () => withControl(async (h, registry) => {
  const hub = registry.open('hub', h.clock);
  hub.bind('hub:bybit', identity('bybit'), 1);
  hub.claim([identity('bybit')]);
  const { jobId } = await previewAndConfirm(h);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'failed');
  assert.match(view.reason ?? '', /ACCOUNT_PINNED/);
  assert.deepEqual([h.binance.calls.place, h.bybit.calls.place], [0, 0]);
  assert.deepEqual(registry.states(), {});
}));

test('写者登记：账户身份不是交易所数字 UID 时拒绝登记，不发送', () => withControl(async h => {
  h.ex.registerAccount({ venue: 'binance', environment: 'simulated', accountId: 'BN1001', accountMode: 'standard', credentialVersion: 1 });
  h.ex.registerAccount({ venue: 'bybit', environment: 'simulated', accountId: 'BY2002', accountMode: 'unified', credentialVersion: 1 });
  const { jobId } = await previewAndConfirm(h);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'failed');
  assert.match(view.reason ?? '', /INVALID_IDENTITY/);
  assert.equal(h.binance.calls.place, 0);
}, { numeric: false }));

test('写者登记：同一账户有未核对的建单时，其他任务不发送；原委托判定未送达并结清后才继续', () => withControl(async (h, registry) => {
  h.bybit.inject({ operation: 'place', mode: 'lost-request' });
  const first = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  const lost = leg(h, first.jobId, 1).operation?.clientOrderId;
  assert.equal(leg(h, first.jobId, 1).operation?.state, 'unknown');
  assert.equal(registry.states()[`platform:create:${lost}`], 'unknown');

  const second = await previewAndConfirm(h, { ...openIntent({ timeoutMs: 3_600_000 }), symbol: 'BZUSDT' });
  for (let i = 0; i < 5; i++) { await h.ex.tick(); h.advance(1_000); }
  assert.equal(h.binance.calls.place, 1, '第二个任务的首腿未发送');
  assert.match(h.ex.jobView(second.jobId).reason ?? '', /写入登记/);

  assert.equal((await settle(h, first.jobId, { ticks: 300 })).status, 'completed');
  assert.equal(registry.states()[`platform:create:${lost}`], 'rejected');
  assert.equal((await settle(h, second.jobId)).status, 'completed');
  const states = registry.states();
  assert.equal(Object.values(states).filter(state => state === 'confirmed').length, 4);
  assert.ok(!Object.values(states).some(state => state === 'sending' || state === 'unknown'));
}));

test('写者登记恢复：登记已写入、本地发送标记未写入时崩溃，新进程把登记结清为未执行后补发', () => withControl(async (h, registry) => {
  h.bybit.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  const lost = leg(h, jobId, 1).operation?.clientOrderId as string;
  // Emulates a kill after the shared prepare and before the local sending mark.
  h.store.db.prepare("UPDATE operations SET state = 'prepared', json = json_set(json, '$.state', 'prepared') WHERE job_id = ? AND leg = 1").run(jobId);
  const db = new DatabaseSync(registry.file);
  try { db.prepare("UPDATE aw_operations SET state = 'sending' WHERE operation_id = ?").run(`platform:create:${lost}`); } finally { db.close(); }
  takeover(h);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.equal(view.legs[1].attempts, 2);
  assert.equal(registry.states()[`platform:create:${lost}`], 'rejected');
  assert.equal(h.bybit.arrived.place, 1);
}));

test('写者登记恢复：发送中崩溃且交易所已成交，新进程按原客户订单号核对到成交后登记为已确认，不补发', () => withControl(async (h, registry) => {
  h.bybit.inject({ operation: 'place', mode: 'lost-response' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  const hedge = leg(h, jobId, 1).operation?.clientOrderId as string;
  h.store.db.prepare("UPDATE operations SET state = 'sending', json = json_set(json, '$.state', 'sending') WHERE job_id = ? AND leg = 1").run(jobId);
  const db = new DatabaseSync(registry.file);
  try { db.prepare("UPDATE aw_operations SET state = 'sending' WHERE operation_id = ?").run(`platform:create:${hedge}`); } finally { db.close(); }
  takeover(h);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.equal(view.legs[1].attempts, 1);
  assert.equal(registry.states()[`platform:create:${hedge}`], 'confirmed');
}));

test('写者登记：前一进程仍存活时新进程不能认领账户，对冲腿等待；前一进程退出后补发', () => withControl(async (h, registry) => {
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  assert.equal(leg(h, jobId, 0).operation?.state, 'filled');
  registry.killOnRestart = false;
  takeover(h);
  for (let i = 0; i < 5; i++) { await h.ex.tick(); h.advance(1_000); }
  assert.equal(h.bybit.calls.place, 0);
  assert.match(h.ex.jobView(jobId).reason ?? '', /对冲腿等待账户写入登记.*OWNER_ALIVE/);
  for (const writer of registry.writers.slice(0, -1)) registry.alive.delete(writer.pid);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.equal(h.bybit.calls.place, 1);
}));

/** Isolates the hedge account right after its create is recorded, before the final check. */
const isolateAfterHedgePrepare: Wrap = writer => new Proxy(writer, {
  get(target, key) {
    if (key === 'prepare') return (ticket: never, operationId: string, payload: never) => {
      const operation = target.prepare(ticket, operationId, payload);
      if (/^platform:create:.*-1$/.test(operationId)) (target as unknown as { freeze(identities: RegistryIdentity[], reason: string): unknown }).freeze([identity('bybit')], 'manual-isolation');
      return operation;
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

test('写者登记：建单登记后账户被隔离，出站前复核拒绝，不出站并转人工', () => withControl(async (h, registry) => {
  const { jobId } = await previewAndConfirm(h);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /ACCOUNT_ISOLATED/);
  assert.equal(h.bybit.arrived.place, 0);
  assert.equal(view.legs[1].operation?.state, 'not-sent');
  // Isolation also refuses finish and resolve: the shared operation stays for manual recovery.
  assert.equal(registry.states()[`platform:create:${view.legs[1].operation?.clientOrderId}`], 'sending');
}, { wrap: isolateAfterHedgePrepare }));

test('写者登记失效（写者已关闭）时执行器整体停止写入', () => withControl(async (h, registry) => {
  const { jobId } = await previewAndConfirm(h);
  registry.current().close();
  await assert.rejects(h.ex.tick(), code('writer_lost'));
  assert.equal(h.ex.retired, true);
  assert.equal(h.binance.calls.place, 0);
  assert.equal(h.ex.jobView(jobId).status, 'accepted');
}));

test('写者登记：对冲连续两次结果未知，每次判定未送达并结清登记后补发，最终完成', () => withControl(async (h, registry) => {
  h.bybit.inject({ operation: 'place', mode: 'lost-request', times: 2 });
  const { jobId } = await previewAndConfirm(h);
  const view = await settle(h, jobId, { ticks: 600 });
  assert.equal(view.status, 'completed');
  assert.equal(view.legs[1].attempts, 3);
  assert.equal(h.bybit.arrived.place, 1);
  const states = Object.values(registry.states());
  assert.deepEqual([states.filter(state => state === 'rejected').length, states.filter(state => state === 'confirmed').length], [2, 2]);
}));

test('写者登记：核对判定未送达的同一轮即结清登记并补发，不因自身未结清登记而等待', () => withControl(async (h, registry) => {
  h.bybit.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  const reasons: string[] = [];
  let view = h.ex.jobView(jobId);
  for (let i = 0; i < 300 && !['completed', 'failed', 'stopped', 'attention'].includes(view.status); i++) {
    await h.ex.tick();
    view = h.ex.jobView(jobId);
    reasons.push(view.reason ?? '');
    h.advance(1_000);
  }
  assert.equal(view.status, 'completed');
  assert.equal(view.legs[1].attempts, 2);
  assert.deepEqual(reasons.filter(reason => /写入登记/.test(reason)), []);
  assert.ok(!Object.values(registry.states()).some(state => state === 'sending' || state === 'unknown'));
}));

test('写者登记：人工确认待处理任务后，其未结清登记按可能已执行释放，账户恢复可写', () => withControl(async (h, registry) => {
  h.bybit.inject({ operation: 'place', mode: 'lost-request' });
  h.bybit.inject({ operation: 'query', mode: 'read-fail', times: 100_000 });
  const first = await previewAndConfirm(h);
  const held = await settle(h, first.jobId, { ticks: 250 });
  assert.equal(held.status, 'attention');
  const lost = `platform:create:${held.legs[1].operation?.clientOrderId}`;
  assert.equal(registry.states()[lost], 'unknown');
  h.ex.acknowledge(first.jobId, randomUUID(), SESSION);
  assert.equal(registry.states()[lost], 'confirmed');
  const after = h.ex.jobView(first.jobId);
  assert.equal(after.legs[1].operation?.state, 'unknown', '本地仍按原客户订单号继续核对');
  assert.deepEqual(after.events.filter(item => item.type === 'control-released').map(item => (item as { operationId?: string }).operationId), [lost]);
  const second = await previewAndConfirm(h);
  assert.equal((await settle(h, second.jobId)).status, 'completed');
}));

interface Busy { cancel: boolean; resolve: boolean }
const busyError = () => Object.assign(new Error('registry busy'), { code: 'REGISTRY_BUSY' });
/** Lets a test make the registry refuse cancel records or resolutions, as a busy registry would. */
const flaky = (busy: Busy): Wrap => writer => new Proxy(writer, {
  get(target, key) {
    if (key === 'prepare') return (ticket: never, operationId: string, payload: never) => {
      if (busy.cancel && operationId.startsWith('platform:cancel:')) throw busyError();
      return target.prepare(ticket, operationId, payload);
    };
    if (key === 'resolve') return (operationId: string, ticket: never, outcome: 'confirmed' | 'rejected') => {
      if (busy.resolve) throw busyError();
      return target.resolve(operationId, ticket, outcome);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

test('写者登记：人工确认时登记暂时拒绝结清，之后每轮重试直至释放', () => {
  const busy: Busy = { cancel: false, resolve: false };
  return withControl(async (h, registry) => {
    h.bybit.inject({ operation: 'place', mode: 'lost-request' });
    h.bybit.inject({ operation: 'query', mode: 'read-fail', times: 100_000 });
    const first = await previewAndConfirm(h);
    const held = await settle(h, first.jobId, { ticks: 250 });
    assert.equal(held.status, 'attention');
    const lost = `platform:create:${held.legs[1].operation?.clientOrderId}`;
    busy.resolve = true;
    h.ex.acknowledge(first.jobId, randomUUID(), SESSION);
    await h.ex.tick();
    assert.equal(registry.states()[lost], 'unknown');
    busy.resolve = false;
    await h.ex.tick();
    assert.equal(registry.states()[lost], 'confirmed');
    assert.deepEqual(h.ex.jobView(first.jobId).events.filter(item => item.type === 'control-resolved').map(item => (item as { operationId?: string; outcome?: string })).map(item => [item.operationId, item.outcome]), [[lost, 'confirmed']]);
    const second = await previewAndConfirm(h);
    assert.equal((await settle(h, second.jobId)).status, 'completed');
  }, { wrap: flaky(busy) });
});

test('写者登记：接管前留下的撤单受阻计时不沿用，新写者从接管起计满宽限期', () => {
  const busy: Busy = { cancel: false, resolve: false };
  return withControl(async (h, registry) => {
    const { jobId } = await previewAndConfirm(h, openIntent({ orderType: 'limit', limitPrice: '69.00', timeoutMs: 3_600_000 }));
    await h.ex.tick();
    assert.equal(leg(h, jobId, 0).operation?.state, 'open');
    busy.cancel = true;
    h.ex.requestStop(jobId, randomUUID(), SESSION);
    for (let i = 0; i < 30; i++) { await h.ex.tick(); h.advance(1_000); }
    assert.match(leg(h, jobId, 0).operation?.note ?? '', /撤单未发送.*REGISTRY_BUSY/);
    takeover(h);
    for (let i = 0; i < 15; i++) { await h.ex.tick(); h.advance(1_000); }
    assert.equal(h.ex.jobView(jobId).status, 'running');
    assert.equal(h.binance.calls.cancel, 0);
    busy.cancel = false;
    const view = await settle(h, jobId);
    assert.equal(view.status, 'stopped');
    assert.equal(h.binance.calls.cancel, 1);
    assert.equal(registry.states()[`platform:cancel:${leg(h, jobId, 0).operation?.clientOrderId}:1`], 'confirmed');
  }, { wrap: flaky(busy) });
});

test('写者登记：撤单登记为独立操作；撤单结果未知时阻止新撤单，超过签名有效窗口后仍见挂单才结清为未执行', () => withControl(async (h, registry) => {
  const { jobId } = await previewAndConfirm(h, openIntent({ orderType: 'limit', limitPrice: '69.00', timeoutMs: 3_600_000 }));
  await h.ex.tick();
  const lead = leg(h, jobId, 0).operation?.clientOrderId as string;
  assert.equal(leg(h, jobId, 0).operation?.state, 'open');
  h.binance.inject({ operation: 'cancel', mode: 'lost-request' });
  h.ex.requestStop(jobId, randomUUID(), SESSION);
  await h.ex.tick();
  assert.equal(registry.states()[`platform:cancel:${lead}:1`], 'unknown');
  h.advance(15_000);
  await h.ex.tick();
  assert.equal(h.binance.calls.cancel, 1, '未核对的撤单阻止下一次撤单');
  assert.match(leg(h, jobId, 0).operation?.note ?? '', /撤单未发送.*ACCOUNT_UNRESOLVED/);
  const view = await settle(h, jobId, { ticks: 200 });
  assert.equal(view.status, 'stopped');
  const states = registry.states();
  assert.equal(states[`platform:cancel:${lead}:1`], 'rejected');
  assert.equal(states[`platform:cancel:${lead}:2`], 'confirmed');
  assert.equal(states[`platform:create:${lead}`], 'confirmed');
}, { budgets: { callTimeoutMs: 35_000 } }));

test('写者登记：模拟传输不得以 mainnet 身份登记，调用预算须在登记租约之内', () => {
  const registry = createRegistry(), h = createHarness();
  try {
    const writer = registry.open('platform', h.clock);
    assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, h.bybit], control: { writer, environment: 'mainnet' as never } }), code('control_environment'));
    assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, h.bybit], budgets: { callTimeoutMs: 55_000 }, control: { writer, environment: 'testnet' } }), code('control_budget'));
  } finally { h.dispose(); registry.dispose(); }
});

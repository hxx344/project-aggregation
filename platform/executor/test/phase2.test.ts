import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../src/contracts.ts';
import { bandEdge } from '../src/decimal.ts';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, WAL_SIZE_LIMIT_BYTES, openStore, sqlHash } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { SESSION, bindAccounts, createHarness, openIntent, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
async function withHarness(run: (h: Harness) => Promise<void>, options?: Parameters<typeof createHarness>[0]) {
  const h = createHarness(options);
  try { await run(h); } finally { h.dispose(); }
}
const hedgeOrders = (h: Harness) => [...h.bybit.orders.values()].map(order => order.request);
const takeover = (h: Harness) => { h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true); };

test('价格保护界限：买向下取整、卖向上取整，只收窄不放宽', () => {
  assert.equal(bandEdge('70.02', 50, 'up', '0.01'), '70.37');
  assert.equal(bandEdge('70.05', 50, 'down', '0.01'), '69.7');
  assert.equal(bandEdge('100', 0, 'up', '0.5'), '100');
  assert.equal(bandEdge('100.3', 0, 'down', '0.5'), '100.5');
  assert.throws(() => bandEdge('70', 10_000, 'down', '0.01'));
  assert.throws(() => bandEdge('0', 10, 'up', '0.01'));
});

test('接管补发：对冲腿落盘后、发送前崩溃，新写者记为未发送并用新客户订单号补发，任务完成', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  // Emulates a kill between the hedge's prepare and send transactions.
  h.store.db.prepare("UPDATE operations SET state = 'prepared', json = json_set(json, '$.state', 'prepared') WHERE job_id = ? AND leg = 1").run(jobId);
  takeover(h);
  assert.equal(h.ex.jobView(jobId).holdNewSends, true);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.equal(view.legs[1].attempts, 2);
  assert.match(view.legs[1].operation?.clientOrderId ?? '', /-1r1$/);
  assert.equal(h.bybit.position('BY2002', 'CLUSDT', 'short'), '1');
  assert.deepEqual([h.binance.calls.place, h.bybit.arrived.place], [1, 1]);
}));

test('接管补发：对冲腿发送中崩溃，按原客户订单号核对；判定未送达后才补发，绝不重复对冲', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  h.store.db.prepare("UPDATE operations SET state = 'sending', json = json_set(json, '$.state', 'sending') WHERE job_id = ? AND leg = 1").run(jobId);
  takeover(h);
  assert.equal(h.ex.jobView(jobId).legs[1].operation?.state, 'unknown');
  await h.ex.tick();
  assert.equal(h.bybit.calls.place, 1, '结果未知期间不补发');
  const view = await settle(h, jobId, { ticks: 300 });
  assert.equal(view.status, 'completed');
  assert.equal(view.legs[1].attempts, 2);
  assert.equal(h.bybit.position('BY2002', 'CLUSDT', 'short'), '1');
  assert.equal(h.bybit.arrived.place, 1);
}));

test('接管补发：对冲腿实际已成交（回报未写入）时核对到成交，不补发', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'lost-response' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  takeover(h);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.equal(view.legs[1].attempts, 1);
  assert.equal(h.bybit.position('BY2002', 'CLUSDT', 'short'), '1');
}));

test('补发：对冲腿 IOC 部分成交，按差额补发；用尽次数后转人工并保留锁', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.4' });
  const first = await previewAndConfirm(h);
  const done = await settle(h, first.jobId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(hedgeOrders(h).map(order => order.quantity), ['1', '0.6']);
  assert.equal(done.legs[1].filledQuantity, '1');

  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0', times: 10 });
  const second = await previewAndConfirm(h);
  const view = await settle(h, second.jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /对冲腿已发送 5 次仍差 1/);
  assert.equal(view.locked, true);
  assert.equal(view.legs[1].attempts, 5);
}));

test('补发：两次对冲之间对冲账户持仓被外部改动，宽限期内持续不一致才转人工，不补发', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.4' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  assert.equal(h.ex.jobView(jobId).legs[1].filledQuantity, '0.4');
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0.9');
  const view = await settle(h, jobId, { ticks: 100 });
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /持续无法发送（最后原因：持仓核对，.*持仓已变化/);
  assert.equal(h.bybit.calls.place, 1);
}));

test('补发：对冲成交后交易所持仓暂未反映，等待期间不发送，持仓追上后补发完成', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.4' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0');
  for (let i = 0; i < 5; i++) { await h.ex.tick(); h.advance(1_000); }
  assert.equal(h.bybit.calls.place, 1);
  assert.match(h.ex.jobView(jobId).reason ?? '', /对冲腿等待持仓核对/);
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0.4');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.deepEqual(hedgeOrders(h).map(order => order.quantity), ['1', '0.6']);
}));

test('补发：每次等待单独计时，前一次等待结束后，下一次等待从头计满宽限期', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.4' });
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.3' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0');
  for (let i = 0; i < 50; i++) { await h.ex.tick(); h.advance(1_000); }
  assert.equal(h.bybit.calls.place, 1);
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0.4');
  await h.ex.tick();
  assert.equal(h.bybit.calls.place, 2);
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0.4');
  for (let i = 0; i < 15; i++) { await h.ex.tick(); h.advance(1_000); }
  const waiting = h.ex.jobView(jobId);
  assert.equal(waiting.status, 'running');
  assert.match(waiting.reason ?? '', /对冲腿等待持仓核对/);
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0.7');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.deepEqual(hedgeOrders(h).map(order => order.quantity), ['1', '0.6', '0.3']);
}));

test('补发：接管前留下的等待计时不沿用，新写者从接管起计满宽限期', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.4' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0');
  for (let i = 0; i < 30; i++) { await h.ex.tick(); h.advance(1_000); }
  assert.match(h.ex.jobView(jobId).reason ?? '', /对冲腿等待持仓核对/);
  takeover(h);
  for (let i = 0; i < 15; i++) { await h.ex.tick(); h.advance(1_000); }
  const waiting = h.ex.jobView(jobId);
  assert.equal(waiting.status, 'running');
  assert.match(waiting.reason ?? '', /对冲腿等待持仓核对/);
  h.bybit.setPosition('BY2002', 'CLUSDT', 'short', '0.4');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.deepEqual(hedgeOrders(h).map(order => order.quantity), ['1', '0.6']);
}));

test('补发：对冲腿被交易所明确拒绝不补发；停止请求后不补发', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'reject' });
  const refused = await settle(h, (await previewAndConfirm(h)).jobId);
  h.ex.acknowledge(refused.id, randomUUID(), SESSION);
  assert.equal(refused.status, 'attention');
  assert.match(refused.reason ?? '', /对冲腿被交易所拒绝/);
  assert.equal(h.bybit.calls.place, 1);

  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.4' });
  const stopped = await previewAndConfirm(h);
  await h.ex.tick();
  await h.ex.tick();
  h.ex.requestStop(stopped.jobId, randomUUID(), SESSION);
  const view = await settle(h, stopped.jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /已请求停止，不再补发对冲腿/);
  assert.equal(h.bybit.calls.place, 2);
}));

test('价格保护：可立即成交且越过界限的限价被预览拒绝；未越界的被动限价照常', () => withHarness(async h => {
  bindAccounts(h.ex);
  await assert.rejects(h.ex.preview(openIntent({ orderType: 'limit', limitPrice: '80.00' }), SESSION), code('limit_beyond_bound'));
  const passive = await h.ex.preview(openIntent({ orderType: 'limit', limitPrice: '69.00' }), SESSION);
  assert.equal(passive.legs[0].limitPrice, '69');
}));

test('预算校验：补发次数须能放进客户订单号，价格保护基点须在范围内', () => withHarness(async h => {
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, h.bybit], budgets: { hedgeAttempts: 100 } }), code('budget'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, h.bybit], budgets: { maxSlippageBps: 0 } }), code('budget'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, h.bybit], budgets: { maxSlippageBps: 10_000 } }), code('budget'));
}));

test('价格保护：首腿以预览界限的 IOC 限价发送；对冲腿仍为市价', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { preview, jobId } = await previewAndConfirm(h);
  assert.equal(preview.legs[0].priceBound, '70.37');
  assert.equal(preview.legs[1].priceBound, '69.7');
  assert.ok(preview.notes.some(note => note.includes('IOC 限价 70.37')));
  h.binance.setBook('CLUSDT', { bid: '70.08', ask: '70.10' });
  assert.equal((await settle(h, jobId)).status, 'completed');
  const lead = [...h.binance.orders.values()][0].request;
  assert.deepEqual([lead.type, lead.limitPrice, lead.timeInForce], ['limit', '70.37', 'ioc']);
  const hedge = hedgeOrders(h)[0];
  assert.deepEqual([hedge.type, hedge.limitPrice, hedge.timeInForce], ['market', null, 'ioc']);
}));

test('价格保护：发送前任一腿盘口越过界限，整单不发送', () => withHarness(async h => {
  bindAccounts(h.ex);
  const lead = await previewAndConfirm(h);
  h.binance.setBook('CLUSDT', { bid: '70.38', ask: '70.40' });
  const failed = await settle(h, lead.jobId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason ?? '', /越过价格保护界限 70.37/);
  h.binance.setBook('CLUSDT', { bid: '70.00', ask: '70.02' });

  const hedge = await previewAndConfirm(h);
  h.bybit.setBook('CLUSDT', { bid: '69.60', ask: '69.62' });
  const refused = await settle(h, hedge.jobId);
  assert.equal(refused.status, 'failed');
  assert.match(refused.reason ?? '', /Bybit CLUSDT 盘口 69.6 已越过价格保护界限 69.7/);
  assert.equal(h.binance.calls.place + h.bybit.calls.place, 0);
}));

test('价格保护：意图可收紧基点，越界值被拒绝', () => withHarness(async h => {
  bindAccounts(h.ex);
  const tight = await h.ex.preview({ ...openIntent(), maxSlippageBps: 1 }, SESSION);
  assert.equal(tight.legs[0].priceBound, '70.02');
  await assert.rejects(h.ex.preview({ ...openIntent(), maxSlippageBps: 0 }, SESSION), code('invalid_value'));
  await assert.rejects(h.ex.preview({ ...openIntent(), maxSlippageBps: 1001 }, SESSION), code('invalid_value'));
  await assert.rejects(h.ex.preview({ ...openIntent(), maxSlippageBps: '5' }, SESSION), code('invalid_value'));
}));

test('同窗盘口：两腿接收时间相差超过窗口时不发送、稍后重试；预览直接拒绝', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId } = await previewAndConfirm(h);
  h.bybit.setBook('CLUSDT', { ageMs: 2_000 });
  await h.ex.tick();
  const waiting = h.ex.jobView(jobId);
  assert.equal(waiting.status, 'accepted');
  assert.match(waiting.reason ?? '', /相差超过 1500 毫秒/);
  await assert.rejects(h.ex.preview(openIntent(), SESSION), code('symbol_locked'));
  h.bybit.setBook('CLUSDT', { ageMs: 0 });
  assert.equal((await settle(h, jobId)).status, 'completed');
  h.bybit.setBook('CLUSDT', { ageMs: 2_000 });
  await assert.rejects(h.ex.preview(openIntent({ action: 'close' }), SESSION), code('quote_window'));
}));

test('保留期：只清理已结束、委托全结清且无需人工的任务的事件、命令与预览；任务与委托保留', () => withHarness(async h => {
  bindAccounts(h.ex);
  const done = await previewAndConfirm(h);
  assert.equal((await settle(h, done.jobId)).status, 'completed');
  h.bybit.inject({ operation: 'place', mode: 'reject' });
  const held = await previewAndConfirm(h, openIntent({ action: 'close' }));
  assert.equal((await settle(h, held.jobId)).status, 'attention');
  const count = (table: string, where = '1 = 1', ...args: string[]) => (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;
  const before = { done: count('events', 'job_id = ?', done.jobId), held: count('events', 'job_id = ?', held.jobId) };
  assert.ok(before.done > 0 && before.held > 0);

  // A preview ages from its expiry (30 s after preview), so it needs that much longer than events.
  h.advance(91_000);
  h.ex.prune();
  assert.equal(count('events', 'job_id = ?', done.jobId), 0);
  assert.equal(count('commands', 'job_id = ?', done.jobId), 0);
  assert.equal(count('previews', 'consumed_job = ?', done.jobId), 0);
  assert.equal(count('events', "type = 'account-bound'"), 0);
  assert.equal(count('jobs', 'id = ?', done.jobId), 1);
  assert.equal(count('operations', 'job_id = ?', done.jobId), 2);
  assert.ok(count('events', 'job_id = ?', held.jobId) >= before.held, '未确认的待人工任务保留证据');
  assert.equal(count('commands', 'job_id = ?', held.jobId), 1);
  assert.equal(count('events', "type = 'history-pruned'"), 1);

  h.ex.acknowledge(held.jobId, randomUUID(), SESSION);
  h.ex.prune();
  assert.ok(count('commands', 'job_id = ?', held.jobId) > 0, '刚确认的任务尚未过保留期');
  h.advance(61_000);
  h.ex.prune();
  assert.equal(count('events', 'job_id = ?', held.jobId), 0);
  assert.equal(count('commands', 'job_id = ?', held.jobId), 0);
}, { budgets: { historyRetentionMs: 60_000, pruneIntervalMs: 3_600_000 } }));

test('保留期：已确认的待人工任务仍有未结清委托时，证据保留', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'lost-request' });
  h.bybit.inject({ operation: 'query', mode: 'read-fail', times: 10_000 });
  const { jobId } = await previewAndConfirm(h);
  const view = await settle(h, jobId, { ticks: 250 });
  assert.equal(view.status, 'attention');
  assert.equal(view.legs[1].operation?.state, 'unknown');
  h.ex.acknowledge(jobId, randomUUID(), SESSION);
  h.advance(120_000);
  h.ex.prune();
  const count = (table: string) => (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id = ?`).get(jobId) as { n: number }).n;
  assert.ok(count('events') > 0);
  assert.equal(count('commands'), 2);
}, { budgets: { historyRetentionMs: 60_000 } }));

test('保留期：单次清理有批量上限；未结束任务的命令保留', () => withHarness(async h => {
  bindAccounts(h.ex);
  for (let i = 0; i < 3; i++) await settle(h, (await previewAndConfirm(h)).jobId);
  const open = await previewAndConfirm(h, openIntent({ orderType: 'limit', limitPrice: '69.00', timeoutMs: 3_600_000 }));
  await h.ex.tick();
  h.advance(61_000);
  const first = h.ex.prune();
  assert.equal(first.events, 2);
  assert.equal(first.commands, 2);
  for (let i = 0; i < 20; i++) h.ex.prune();
  const count = (sql: string, ...args: string[]) => (h.store.db.prepare(sql).get(...args) as { n: number }).n;
  assert.equal(count('SELECT COUNT(*) AS n FROM commands WHERE job_id != ?', open.jobId), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM commands WHERE job_id = ?', open.jobId), 1);
  assert.ok(count('SELECT COUNT(*) AS n FROM events WHERE job_id = ?', open.jobId) > 0);
}, { budgets: { historyRetentionMs: 60_000, pruneBatch: 2 } }));

test('存储：已有 v1 库升级到 v2 保留数据并补齐索引', () => withHarness(async h => {
  const file = h.file.replace(/executor\.sqlite$/, 'v1.sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sql_sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  old.exec(MIGRATIONS[0].sql);
  old.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?, 0)').run(MIGRATIONS[0].name, sqlHash(MIGRATIONS[0].sql));
  old.prepare("INSERT INTO events(job_id, type, at, json) VALUES (NULL, 'legacy', 1, '{}')").run();
  old.close();
  const store = openStore(file);
  try {
    assert.equal(store.schemaVersion(), MIGRATIONS.at(-1)!.version);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'legacy'").get() as { n: number }).n, 1);
    const indexes = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(row => row.name);
    for (const name of ['events_at', 'commands_accepted', 'previews_consumed']) assert.ok(indexes.includes(name), name);
  } finally { store.close(); }
}));

test('存储：WAL 截断上限与保留期索引迁移', () => withHarness(async h => {
  assert.equal((h.store.db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit, WAL_SIZE_LIMIT_BYTES);
  assert.equal(h.store.schemaVersion(), MIGRATIONS.at(-1)!.version);
  const indexes = (h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(row => row.name);
  for (const name of ['events_at', 'commands_accepted', 'previews_consumed']) assert.ok(indexes.includes(name), name);
}));

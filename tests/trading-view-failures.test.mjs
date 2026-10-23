import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTrading } from '../server/trading.mjs';

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 7) });
  const db = new DatabaseSync(':memory:'), logs = [];
  const trading = createTrading({
    db, encrypt: JSON.stringify, decrypt: JSON.parse, intervalMs: 0,
    logger: { error: (record, message) => logs.push({ ...record, message, time: Date.now() }) },
    clientFactory: exchange => ({
      verify: async () => ({ positions: [], fetchedAt: new Date().toISOString() }),
      positions: async () => ({ positions: [], fetchedAt: new Date().toISOString() }),
      funding: async (_, { start, end }) => ({ events: [], coverage: [{ start, end }], complete: true, fetchedAt: new Date().toISOString() }),
    }),
  });
  t.after(async () => { await trading.close(); db.close(); });
  await trading.connect('binance', { revision: 0, apiKey: 'fixture_only_key', apiSecret: 'fixture_only_secret' });
  await trading.refresh();
  return {
    db, trading, logs,
    async fail() {
      db.exec("CREATE TRIGGER reject_view BEFORE INSERT ON trading_views_v2 BEGIN SELECT RAISE(FAIL, 'private SQL and account value'); END");
      t.mock.timers.tick(6000);
      await trading.refresh({ force: true });
    },
  };
}

test('视图重建异常记录脱敏日志并退避，自动刷新不能绕过重试间隔', async t => {
  const f = await fixture(t);
  const before = f.trading.state();
  await f.fail();
  assert.equal(f.logs.length, 1);
  let state = f.trading.state();
  assert.equal(state.cache.builtAt, before.cache.builtAt);
  assert.equal(state.cache.rebuilding, true);
  assert.equal(state.cache.error.code, 'view_rebuild_failed');
  assert.equal(state.cache.error.at, new Date().toISOString());
  assert.match(state.cache.error.message, /更新失败/);
  assert.equal(f.logs[0].category, 'ERR_SQLITE_ERROR');
  for (const delay of [750, 1500, 3000, 6000, 12000, 24000, 30000, 30000]) {
    const count = f.logs.length;
    assert.equal(f.logs.at(-1).retryInMs, delay);
    await f.trading.refresh({ force: true });
    assert.equal(f.logs.length, count, '显式刷新也不提前重建');
    t.mock.timers.tick(delay - 1);
    await f.trading.refresh();
    assert.equal(f.logs.length, count, '新的失效事件也不缩短退避');
    t.mock.timers.tick(1);
    assert.equal(f.logs.length, count + 1);
    assert.equal(f.logs.at(-1).time - f.logs.at(-2).time, delay);
  }
  assert.doesNotMatch(JSON.stringify([f.logs, f.trading.state()]), /private SQL|account value|RAISE|INSERT INTO/);
  const count = f.logs.length;
  f.db.exec('DROP TRIGGER reject_view');
  t.mock.timers.tick(30000);
  state = f.trading.state();
  assert.equal(state.cache.error, null);
  assert.equal(state.cache.rebuilding, false);
  assert.equal(state.cache.builtAt, new Date().toISOString());
  assert.equal(f.logs.length, count);
  await f.fail();
  assert.equal(f.logs.at(-1).retryInMs, 750, '恢复后下一次独立失败从初始间隔开始');
});

test('启动时首次重建失败直接报错，不遗留后台重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 7) });
  const db = new DatabaseSync(':memory:'), logs = [];
  t.after(() => db.close());
  db.exec('CREATE TABLE trading_views_v2 (pair_key TEXT NOT NULL, days INTEGER NOT NULL, version INTEGER NOT NULL, source_key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(pair_key,days))');
  db.exec("CREATE TRIGGER reject_view BEFORE INSERT ON trading_views_v2 BEGIN SELECT RAISE(FAIL, 'startup failure'); END");
  assert.throws(() => createTrading({ db, encrypt: JSON.stringify, decrypt: JSON.parse, intervalMs: 0,
    logger: { error: record => logs.push(record) } }));
  assert.equal(logs.length, 1);
  t.mock.timers.tick(120000);
  assert.equal(logs.length, 1);
});

test('断开连接后重建失败时读取返回 503，故障解除后按退避恢复且账户状态一致', async t => {
  const f = await fixture(t);
  const { revision } = f.db.prepare("SELECT revision FROM trading_accounts WHERE exchange='binance'").get();
  f.db.exec("CREATE TRIGGER reject_view BEFORE INSERT ON trading_views_v2 BEGIN SELECT RAISE(FAIL, 'reset failure'); END");
  assert.throws(() => f.trading.disconnect('binance', revision));
  assert.throws(() => f.trading.state(), error => error.status === 503);
  const row = f.db.prepare("SELECT revision, credentials FROM trading_accounts WHERE exchange='binance'").get();
  assert.equal(row.revision, revision + 1);
  assert.equal(row.credentials, null);
  f.db.exec('DROP TRIGGER reject_view');
  t.mock.timers.tick(750);
  const state = f.trading.state();
  assert.equal(state.cache.error, null);
  assert.equal(state.accounts.find(account => account.exchange === 'binance').revision, revision + 1);
});

test('关闭交易服务取消重建重试，失败时读取不会触发额外重建', async t => {
  const f = await fixture(t);
  await f.fail();
  const count = f.logs.length;
  for (let i = 0; i < 10; i++) assert.equal(f.trading.state().cache.error.code, 'view_rebuild_failed');
  assert.equal(f.logs.length, count);
  await f.trading.close();
  t.mock.timers.tick(120000);
  assert.equal(f.logs.length, count);
});

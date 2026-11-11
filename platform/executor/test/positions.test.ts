// ASTER position display (plan 2.3c, simulated only): the read contract, the
// validity of retained rows after a failed read, the per-symbol totals and when
// they give a verdict, one read per account per round, and the boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../src/contracts.ts';
import { MAX_ANSWER_ROWS, MAX_POSITION_ROWS, parseAsterPositions } from '../src/positions.ts';
import { SIM_TRANSFER_PAIR } from '../src/simulation.ts';
import { createHarness, type Harness } from './harness.ts';
import { createExecutor, type Budgets } from '../src/executor.ts';
import { openStore } from '../src/store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { id: PAIR, long: LONG, short: SHORT } = SIM_TRANSFER_PAIR;
const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const QUICK: Partial<Budgets> = { positionsReadTimeoutMs: 50 };
const NOW = Date.UTC(2026, 10, 12, 1, 0, 0);

async function withPositions(run: (h: Harness) => Promise<void>, budgets: Partial<Budgets> = {}) {
  const h = createHarness({ budgets: { ...QUICK, ...budgets } });
  try {
    h.ex.registerTransferPair(SIM_TRANSFER_PAIR);
    await run(h);
  } finally { h.asterTrading.releaseHung(); h.dispose(); }
}
const pairView = (h: Harness) => h.ex.asterPositions().pairs.find(item => item.pairId === PAIR)!;
const row = (over: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', positionSide: 'LONG', amount: '0.5', entryPrice: '59000', markPrice: '60000', unrealizedProfit: '500', updateTime: NOW - 1_000, ...over });

test('持仓契约：只留非零行并按合约排序，空仓数量取绝对值，名义价值按标记价计算', () => {
  const parsed = parseAsterPositions({ accountId: LONG, receivedAt: NOW, positions: [
    row({ symbol: 'ETHUSDT', positionSide: 'SHORT', amount: '-2', entryPrice: '3000', markPrice: '2900', unrealizedProfit: '200' }),
    row(), row({ positionSide: 'SHORT', amount: '0', unrealizedProfit: '0' }),
  ] }, LONG, NOW, 1_000);
  assert.deepEqual(parsed.positions.map(item => [item.symbol, item.direction, item.quantity, item.notional]), [['BTCUSDT', 'long', '0.5', '30000'], ['ETHUSDT', 'short', '2', '5800']]);
});

test('持仓契约：零持仓行不校验价格、不计入持仓上限；单向持仓按数量符号定方向；整个回复另有行数上限', () => {
  const zero = Array.from({ length: MAX_POSITION_ROWS + 10 }, (_, i) => row({ symbol: `Z${i}USDT`, amount: '0', entryPrice: '0', markPrice: '0', unrealizedProfit: '0' }));
  const parsed = parseAsterPositions({ accountId: LONG, receivedAt: NOW, positions: [...zero, row({ positionSide: 'BOTH', amount: '-0.3' })] }, LONG, NOW, 1_000);
  assert.deepEqual(parsed.positions.map(item => [item.positionSide, item.direction, item.quantity]), [['BOTH', 'short', '0.3']]);
  assert.throws(() => parseAsterPositions({ accountId: LONG, receivedAt: NOW, positions: Array.from({ length: MAX_ANSWER_ROWS + 1 }, () => ({})) }, LONG, NOW, 1_000), code('positions_shape'));
});

test('持仓契约：账户不符、数量符号与方向矛盾、重复行、多余字段、时间超前与行数超限都拒绝', () => {
  const parse = (positions: unknown[], accountId = LONG, receivedAt = NOW) => parseAsterPositions({ accountId, receivedAt, positions }, LONG, NOW, 1_000);
  assert.throws(() => parse([row()], SHORT), code('account_identity'));
  assert.throws(() => parse([row({ amount: '-1' })]), code('position_shape'));
  assert.throws(() => parse([row(), row()]), code('position_shape'));
  assert.throws(() => parse([{ ...row(), leverage: '5' }]), ContractError);
  assert.throws(() => parse([row({ updateTime: NOW + 2_000 })]), code('venue_time'));
  assert.throws(() => parse([row()], LONG, NOW + 2_000), code('venue_time'));
  assert.throws(() => parse(Array.from({ length: MAX_POSITION_ROWS + 1 }, (_, i) => row({ symbol: `S${i}USDT` }))), code('positions_shape'));
});

test('持仓展示：首轮前为尚未读取，读取后两侧最新并按合约给出一致结论，每个账户每轮只读一次', () => withPositions(async h => {
  assert.equal(pairView(h).long.state, 'pending');
  assert.equal(pairView(h).totals, null);
  // Two calls during one round share it.
  await Promise.all([h.ex.refreshPositions(), h.ex.refreshPositions()]);
  assert.equal(h.asterTrading.calls.positions, 2);
  const view = pairView(h);
  assert.equal(view.long.state, 'fresh');
  assert.equal(view.long.sampledAt, h.clock.now);
  assert.deepEqual(view.long.positions.map(item => [item.symbol, item.direction, item.quantity]), [['BTCUSDT', 'long', '0.05']]);
  assert.deepEqual(view.short.positions.map(item => [item.direction, item.quantity]), [['short', '0.05']]);
  assert.deepEqual(view.totals, [{ symbol: 'BTCUSDT', long: '0.05', short: '-0.05', total: '0', balanced: true }]);
  // Read-only: nothing reached the venue's order path.
  assert.deepEqual(h.asterTrading.arrived, { place: 0, cancel: 0 });
}));

test('持仓展示：ADL 后一侧变少，两侧最新时判为不一致；未实现盈亏随标记价变化', () => withPositions(async h => {
  h.asterTrading.setMark('BTCUSDT', '61000');
  h.asterTrading.adl(LONG, 'BTCUSDT', 'LONG', '0.02', { push: false });
  await h.ex.refreshPositions();
  const view = pairView(h);
  assert.deepEqual(view.totals, [{ symbol: 'BTCUSDT', long: '0.03', short: '-0.05', total: '-0.02', balanced: false }]);
  assert.equal(view.long.positions[0].unrealizedProfit, '30');
  assert.equal(view.short.positions[0].unrealizedProfit, '-50');
}));

test('持仓展示：读取失败保留上次结果到有效期截止并注明，不判断一致；超过有效期不再显示，恢复后立即最新', () => withPositions(async h => {
  await h.ex.refreshPositions();
  h.advance(15_000);
  h.asterTrading.inject({ operation: 'positions', mode: 'read-fail', accountId: SHORT, times: 2 });
  await h.ex.refreshPositions();
  let view = pairView(h);
  assert.equal(view.long.state, 'fresh');
  assert.equal(view.short.state, 'retained');
  assert.match(view.short.note!, /模拟持仓读取失败/);
  assert.equal(view.short.ageMs, 15_000);
  assert.equal(view.short.positions.length, 1);
  assert.equal(view.totals![0].balanced, null);
  // 45 s after the last good read the rows are gone, whether or not another read was tried.
  h.advance(30_000);
  await h.ex.refreshPositions();
  assert.equal(pairView(h).short.state, 'retained');
  h.advance(1);
  view = pairView(h);
  assert.equal(view.short.state, 'unavailable');
  assert.deepEqual(view.short.positions, []);
  assert.equal(view.totals, null);
  assert.match(view.short.note!, /模拟持仓读取失败/);
  await h.ex.refreshPositions();
  view = pairView(h);
  assert.equal(view.short.state, 'fresh');
  assert.equal(view.short.note, null);
  assert.equal(view.totals![0].balanced, true);
}));

test('持仓展示：只在有效期内显示旧结果，读取成功但未再刷新时超期也注明未更新', () => withPositions(async h => {
  await h.ex.refreshPositions();
  h.advance(45_000);
  assert.equal(pairView(h).long.state, 'fresh');
  h.advance(1);
  const side = pairView(h).long;
  assert.equal(side.state, 'unavailable');
  assert.match(side.note!, /45 秒未更新/);
  await h.ex.refreshPositions();
  assert.equal(pairView(h).long.state, 'fresh');
}));

test('持仓展示：读取挂起按超时记为失败，不拖住任务循环；结构无效的回复同样记为失败', () => withPositions(async h => {
  h.asterTrading.inject({ operation: 'positions', mode: 'hang', accountId: LONG });
  h.asterTrading.inject({ operation: 'positions', mode: 'malformed', accountId: SHORT });
  const tick = h.ex.tick();
  await h.ex.refreshPositions();
  await tick;
  const view = pairView(h);
  assert.equal(view.long.state, 'unavailable');
  assert.match(view.long.note!, /超过 50 毫秒/);
  assert.equal(view.short.state, 'unavailable');
  assert.match(view.short.note!, /ASTER 持仓读取失败/);
}));

test('持仓展示：两侧都最新但采样相隔超过一次读取时限时只汇总、不判断一致', () => withPositions(async h => {
  const original = h.asterTrading.positions.bind(h.asterTrading);
  // One account at a time, and the long read takes longer than the read limit's worth of clock.
  h.asterTrading.positions = async (accountId, options) => { const answer = await original(accountId, options); if (accountId === LONG) h.clock.now += 51; return answer; };
  await h.ex.refreshPositions();
  const view = pairView(h);
  assert.equal(view.long.state, 'fresh');
  assert.equal(view.short.state, 'fresh');
  assert.equal(view.verdictNote, '两侧采样相隔过久');
  assert.deepEqual(view.totals, [{ symbol: 'BTCUSDT', long: '0.05', short: '-0.05', total: '0', balanced: null }]);
}, { positionsConcurrency: 1 }));

test('持仓展示：本机时钟回退后不再把旧结果当有效', () => withPositions(async h => {
  await h.ex.refreshPositions();
  h.clock.now -= 1_000;
  assert.equal(pairView(h).long.state, 'unavailable');
}));

test('持仓展示：关闭后不再读取；未接入连接器时视图注明不可用', () => withPositions(async h => {
  h.ex.close();
  await h.ex.refreshPositions();
  assert.equal(h.asterTrading.calls.positions, 0);
  const dir = mkdtempSync(join(tmpdir(), 'pa-executor-'));
  const store = openStore(join(dir, 'executor.sqlite'));
  try {
    const bare = createExecutor({ store, connectors: [h.binance, h.bybit], now: () => h.clock.now });
    assert.equal(bare.asterPositions().available, false);
    await bare.refreshPositions();
    bare.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}));

test('持仓预算：有效期须大于刷新间隔加读取时限，非模拟传输拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-executor-'));
  const store = openStore(join(dir, 'executor.sqlite'));
  try {
    const h = { now: () => NOW };
    assert.throws(() => createExecutor({ store, connectors: [], now: h.now, budgets: { positionsRefreshMs: 15_000, positionsReadTimeoutMs: 8_000, positionsMaxAgeMs: 23_000 } }), code('budget'));
    assert.throws(() => createExecutor({ store, connectors: [], now: h.now, budgets: { positionsConcurrency: 0 } }), code('budget'));
    const live = { venue: 'aster' as const, capabilities: { transport: 'live' as unknown as 'simulated' }, positions: async () => ({}) };
    assert.throws(() => createExecutor({ store, connectors: [], now: h.now, positions: live }), code('live_transport_refused'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

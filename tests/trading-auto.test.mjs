import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountWriter } from '../server/execution/account-writer.mjs';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { boundsFor, createTradingAuto, evaluateRule, normalizeRuleConfig } from '../server/trading-auto.mjs';

const baseTime = Date.UTC(2026, 10, 6, 2);
const config = (overrides = {}) => ({ name: '', market: 'oil', exchange: 'binance', direction: 'short', openThreshold: '4', closeThreshold: '2', equalSize: '1', orderType: 'chase',
  confirmSamples: 2, maxOpensPerDay: 3, batchCount: 1, batchIntervalMs: 0, repriceIntervalMs: 1000, timeoutMs: 60_000, ...overrides });
const quotes = (books, at) => ({ generatedAt: new Date(at).toISOString(), maxAgeMs: 10_000, books: Object.entries(books).map(([key, [bid, ask]]) => { const [exchange, symbol] = key.split(':'); return { exchange, symbol, bid, ask, at: new Date(at).toISOString() }; }) });

async function fixture(t, { maintenance = false, start = baseTime, guarded = false } = {}) {
  const db = new DatabaseSync(':memory:');
  let time = start, serial = 0;
  const directory = guarded ? mkdtempSync(join(tmpdir(), 'auto-writer-')) : null;
  const writer = guarded ? createAccountWriter({ databasePath: join(directory, 'execution-control.sqlite'), moduleId: 'hub', runtimeId: randomUUID(), now: () => time }) : null;
  const records = new Map(), hooks = {};
  const prices = { CLUSDT: ['70', '70.01'], BZUSDT: ['75', '75.01'], SKHYUSDT: ['110', '110.1'], SKHYNIXUSDT: ['1000', '1001'] };
  const accounts = Object.fromEntries(['binance', 'bybit', 'okx'].map((exchange, index) => [exchange, { identity: guarded ? String(index + 1) : 'uid', modes: { CLUSDT: 'hedge', BZUSDT: 'hedge', SKHYUSDT: 'hedge', SKHYNIXUSDT: 'hedge' }, positions: [], openOrders: [], strategies: [] }]));
  const factory = exchange => ({
    verify: async () => ({ identity: accounts[exchange].identity }),
    account: async () => { await hooks.account?.(); return structuredClone(accounts[exchange]); },
    endedStrategies: async () => [],
    market: async symbol => { await hooks.market?.(symbol); return { symbol, bid: prices[symbol][0], ask: prices[symbol][1], at: new Date(time).toISOString(), rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null, maxMarketQuantity: '10' } }; },
    create: async (_credentials, spec, options) => { await hooks.create?.(); options.beforeMutation(); const id = String(++serial); records.set(id, { ...spec, exchange, id, kind: exchange === 'bybit' && spec.orderType !== 'market' ? 'strategy' : 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: '70', createdAt: new Date(time).toISOString() }); return { id, kind: records.get(id).kind }; },
    amend: async (_credentials, spec, options) => { options.beforeMutation(); (hooks.amends ??= []).push(spec.symbol); (hooks.amendSpecs ??= []).push(spec); return structuredClone(records.get(spec.id)); },
    inspect: async (_credentials, spec) => { const record = spec.id ? records.get(spec.id) : [...records.values()].find(item => item.clientId === spec.clientId); if (!record) throw new ExecutionError404(); return structuredClone(record); },
    stop: async (_credentials, spec, options) => { options.beforeMutation(); Object.assign(records.get(spec.id), { status: 'terminal', terminal: true, childrenSettled: true }); },
  });
  class ExecutionError404 extends ExecutionExchangeError { constructor() { super('not_found', { notFound: true }); } }
  const execution = createTradingExecution({ db, stmt: null, now: () => time, intervalMs: 0, encrypt: value => JSON.stringify(value), decrypt: JSON.parse, clientFactory: factory, accountWriter: writer });
  await execution.initializeProtection();
  for (const exchange of ['binance', 'bybit', 'okx']) await execution.connect(exchange, { revision: 0, accountMode: exchange === 'binance' ? 'standard' : exchange === 'okx' ? 'cross' : 'unified', apiKey: 'fixture_key', apiSecret: 'fixture_secret', ...(exchange === 'okx' ? { passphrase: 'fixture_private_passphrase' } : {}) });
  const flags = { maintenance };
  const auto = createTradingAuto({ db, execution, now: () => time, intervalMs: 0, readMaintenance: () => flags.maintenance });
  t.after(async () => { await auto.close(); await execution.close(); writer?.close(); db.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const fill = record => {
    Object.assign(record, { filledQuantity: record.quantity, terminal: true, childrenSettled: true, status: 'terminal' });
    const side = record.positionSide === 'LONG' ? 'long' : 'short', account = accounts[record.exchange];
    const position = account.positions.find(row => row.symbol === record.symbol && row.side === side);
    const change = record.reduceOnly ? -Number(record.quantity) : Number(record.quantity), next = (position ? Number(position.quantity) : 0) + change;
    account.positions = account.positions.filter(row => row !== position);
    if (next > 0) account.positions.push({ symbol: record.symbol, side, quantity: String(next) });
  };
  return { db, writer, records, accounts, prices, hooks, flags, execution, auto,
    get time() { return time; }, advance(ms) { time += ms; },
    // Moves the clock in steps the executor's lease survives.
    async wait(ms) { for (let left = ms; left > 0; left -= 10_000) { time += Math.min(left, 10_000); await execution.tick(); } },
    // Each pass moves the clock past the quote cache, so every auto tick reads a new book.
    async step() { time += 3000; await execution.tick(); await auto.tick(); },
    async settle() {
      for (let i = 0; i < 6; i++) {
        await execution.tick();
        for (const record of records.values()) if (!record.terminal) fill(record);
        const job = execution.state().jobs[0];
        if (['completed', 'stopped', 'paused', 'attention'].includes(job?.status)) break;
      }
    },
    get rule() { return auto.state().rules[0]; },
    get jobs() { return execution.state().jobs; },
    locks: () => db.prepare('SELECT resource FROM execution_locks ORDER BY resource').all().map(row => row.resource),
  };
}
const enable = f => f.auto.create({ config: config(), enabled: true, confirmLive: true });

test('executable spread uses the trading side and compares exactly at the threshold', () => {
  const at = baseTime, books = quotes({ 'binance:BZUSDT': ['75', '75.01'], 'binance:CLUSDT': ['70.99', '71'] }, at);
  // Selling the oil spread: BZ bid − CL ask = 4.
  assert.equal(evaluateRule(config({ openThreshold: '4' }), 'open', books, at).met, true);
  assert.equal(evaluateRule(config({ openThreshold: '4.000000000000000001' }), 'open', books, at).met, false);
  // Buying it back: BZ ask − CL bid = 4.02, which must be at or below the close threshold.
  assert.equal(evaluateRule(config({ openThreshold: '5', closeThreshold: '4.02' }), 'close', books, at).met, true);
  assert.equal(evaluateRule(config({ openThreshold: '5', closeThreshold: '4.01' }), 'close', books, at).met, false);
  // A long rule buys first, at BZ ask − CL bid.
  assert.equal(evaluateRule(config({ direction: 'long', openThreshold: '4.02', closeThreshold: '6' }), 'open', books, at).met, true);
  // SK hynix: ADR bid 110 against ordinary ask 1000 ÷ 10 is a 10% premium.
  const hynix = quotes({ 'okx:SKHYUSDT': ['110', '110.5'], 'okx:SKHYNIXUSDT': ['999', '1000'] }, at);
  const premium = config({ market: 'hynix', exchange: 'okx', openThreshold: '10', closeThreshold: '1', equalSize: '1000' });
  assert.equal(evaluateRule(premium, 'open', hynix, at).met, true);
  assert.equal(evaluateRule({ ...premium, openThreshold: '10.0000001' }, 'open', hynix, at).met, false);
  assert.ok(Math.abs(evaluateRule(premium, 'open', hynix, at).value - 10) < 1e-9);
  // Stale or missing books never meet a threshold.
  assert.match(evaluateRule(config(), 'open', books, at + 10_001).error, /过期/);
  assert.match(evaluateRule(config({ exchange: 'okx' }), 'open', books, at).error, /未取得盘口/);
});

test('per-leg limits split the slack and any fill beyond both still meets the threshold', () => {
  const oil = config(), tick = book => ({ ...book, tickSize: '0.01' });
  assert.deepEqual(boundsFor(oil, 'open', tick({ bid: '75', ask: '75.01' }), tick({ bid: '70', ask: '70.01' })), { premium: '74.51', base: '70.51' });
  assert.deepEqual(boundsFor(oil, 'close', tick({ bid: '71.5', ask: '71.51' }), tick({ bid: '70', ask: '70.01' })), { premium: '71.75', base: '69.75' });
  assert.equal(boundsFor(oil, 'open', tick({ bid: '73', ask: '73.01' }), tick({ bid: '70', ask: '70.01' })), null);
  // A deeply negative threshold leaves slack beyond zero: limits stay at least one tick.
  const negative = normalizeRuleConfig(config({ openThreshold: '-150', closeThreshold: '-151' }));
  assert.deepEqual(boundsFor(negative, 'open', tick({ bid: '75', ask: '75.01' }), tick({ bid: '70', ask: '70.01' })), { premium: '0.01', base: '150.01' });
  const negativeLong = normalizeRuleConfig(config({ direction: 'long', openThreshold: '150', closeThreshold: '151' }));
  assert.deepEqual(boundsFor(negativeLong, 'open', tick({ bid: '75', ask: '75.01' }), tick({ bid: '70', ask: '70.01' })), { premium: '147.5', base: '0.01' });
  const hynix = config({ market: 'hynix', exchange: 'okx', openThreshold: '10', closeThreshold: '1', equalSize: '1000' });
  const limits = boundsFor(hynix, 'open', { bid: '111', ask: '111.1', tickSize: '0.01' }, { bid: '999', ask: '1000', tickSize: '0.1' });
  assert.deepEqual(limits, { premium: '110.5', base: '1004.5' });
  // Selling just above the premium limit and buying just below the base limit is still a 10% premium or more.
  const edge = quotes({ 'okx:SKHYUSDT': ['110.51', '110.52'], 'okx:SKHYNIXUSDT': ['1004.3', '1004.4'] }, baseTime);
  assert.equal(evaluateRule(hynix, 'open', edge, baseTime).met, true);
});

test('rule settings are validated before anything is saved', () => {
  assert.throws(() => normalizeRuleConfig(config({ closeThreshold: '4' })), /平仓阈值须低于开仓阈值/);
  assert.throws(() => normalizeRuleConfig(config({ direction: 'long' })), /平仓阈值须高于开仓阈值/);
  assert.throws(() => normalizeRuleConfig({ ...config(), stopPrice: '1' }), /不支持的字段/);
  assert.throws(() => normalizeRuleConfig(config({ equalSize: '0' })), /每腿桶数/);
  assert.throws(() => normalizeRuleConfig(config({ confirmSamples: 0 })), /连续满足次数/);
  for (const field of ['market', 'exchange', 'direction', 'orderType']) assert.throws(() => normalizeRuleConfig(config({ [field]: [config()[field]] })), /请选择|下单方式/, `${field} must be a string`);
  assert.equal(normalizeRuleConfig(config({ openThreshold: '-1.50', closeThreshold: '-3' })).openThreshold, '-1.5');
});

test('a rule opens after distinct confirmations, holds the filled legs, closes at its threshold and re-arms', async t => {
  const f = await fixture(t);
  enable(f);
  await f.step();
  assert.equal(f.rule.live.hits, 1); assert.equal(f.jobs.length, 0);
  // A repeated read of the same cached books is not a second confirmation.
  await f.auto.tick();
  assert.equal(f.rule.live.hits, 1); assert.equal(f.jobs.length, 0);
  await f.step();
  assert.equal(f.jobs.length, 1);
  const open = f.jobs[0];
  assert.deepEqual(open.auto, { ruleId: f.rule.id, action: 'open' });
  assert.deepEqual(open.legs.map(leg => [leg.symbol, leg.side, leg.quantity]), [['BZUSDT', 'short', '1'], ['CLUSDT', 'long', '1']]);
  assert.equal(f.rule.state.phase, 'opening'); assert.equal(f.rule.state.opensToday, 1);
  assert.deepEqual(f.locks(), ['binance:BZUSDT', 'binance:CLUSDT']);
  await f.settle();
  assert.equal(f.jobs[0].status, 'completed');
  await f.auto.tick();
  assert.equal(f.rule.state.phase, 'holding');
  assert.deepEqual(f.rule.state.held.map(leg => [leg.symbol, leg.side, leg.quantity]), [['BZUSDT', 'short', '1'], ['CLUSDT', 'long', '1']]);
  // Still wide: buying back at BZ ask − CL bid = 5.01 is above the close threshold.
  await f.step(); await f.step();
  assert.equal(f.jobs.length, 1);
  f.prices.BZUSDT = ['71.5', '71.51'];
  await f.step(); await f.step();
  assert.equal(f.jobs.length, 2);
  const close = f.jobs.find(job => job.action === 'close');
  assert.deepEqual(close.auto, { ruleId: f.rule.id, action: 'close' });
  assert.equal(f.rule.state.phase, 'closing');
  await f.settle();
  await f.auto.tick();
  assert.equal(f.rule.state.phase, 'idle'); assert.equal(f.rule.state.held, null); assert.equal(f.rule.enabled, true);
  assert.equal([...f.records.values()].filter(record => record.reduceOnly).length, 2);
  assert.deepEqual(f.accounts.binance.positions, []);
});

test('the daily open limit stops new opens until the next Beijing day', async t => {
  // 23:58 Beijing time.
  const f = await fixture(t, { start: Date.UTC(2026, 10, 6, 15, 58) });
  f.auto.create({ config: config({ maxOpensPerDay: 1, confirmSamples: 1 }), enabled: true, confirmLive: true });
  await f.step(); await f.settle(); await f.auto.tick();
  f.prices.BZUSDT = ['71.5', '71.51'];
  await f.step(); await f.settle(); await f.auto.tick();
  assert.equal(f.rule.state.phase, 'idle');
  f.prices.BZUSDT = ['75', '75.01'];
  await f.step(); await f.step();
  assert.equal(f.jobs.length, 2); assert.match(f.rule.live.note, /今日开仓次数已达上限/);
  assert.ok(f.time < Date.UTC(2026, 10, 6, 16));
  await f.wait(Date.UTC(2026, 10, 6, 16) - f.time);
  await f.step();
  assert.equal(f.jobs.length, 3);
});

test('a job that does not complete disables the rule for review; reset needs an explicit acknowledgement', async t => {
  const f = await fixture(t);
  enable(f);
  await f.step(); await f.step();
  const job = f.jobs[0];
  f.execution.stop(job.id, {}, undefined);
  await f.execution.tick();
  assert.equal(f.jobs[0].status, 'stopped');
  await f.auto.tick();
  assert.equal(f.rule.state.phase, 'review'); assert.equal(f.rule.enabled, false);
  assert.match(f.rule.state.reason, /开仓任务已停止/);
  assert.throws(() => f.auto.act(f.rule.id, 'enable', { revision: f.rule.revision, confirmLive: true }), /先核对仓位并重置/);
  assert.throws(() => f.auto.act(f.rule.id, 'reset', { revision: f.rule.revision }), /确认已自行核对/);
  assert.throws(() => f.auto.remove(f.rule.id, { revision: f.rule.revision }), /不能删除/);
  f.auto.act(f.rule.id, 'reset', { revision: f.rule.revision, acknowledge: true });
  assert.equal(f.rule.state.phase, 'idle'); assert.equal(f.rule.enabled, false);
  await f.step(); await f.step();
  assert.equal(f.jobs.length, 1);
});

test('reset waits until the linked job has ended', async t => {
  const f = await fixture(t);
  f.hooks.create = () => { throw new ExecutionExchangeError('交易所拒绝委托'); };
  enable(f);
  await f.step(); await f.step();
  await f.settle();
  assert.equal(f.jobs[0].status, 'paused');
  await f.auto.tick();
  assert.equal(f.rule.state.phase, 'review');
  assert.throws(() => f.auto.act(f.rule.id, 'reset', { revision: f.rule.revision, acknowledge: true }), /关联的自动任务尚未结束/);
  assert.equal(f.rule.state.phase, 'review');
  f.execution.stop(f.jobs[0].id, {}, undefined);
  await f.execution.tick();
  assert.equal(f.jobs[0].status, 'stopped'); assert.deepEqual(f.locks(), []);
  f.auto.act(f.rule.id, 'reset', { revision: f.rule.revision, acknowledge: true });
  assert.equal(f.rule.state.phase, 'idle');
});

test('the books read just before planning must still meet the threshold', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 1 }), enabled: true, confirmLive: true });
  // The spread narrows between the shared quote read and the executor's own read.
  f.hooks.account = () => { f.hooks.account = null; f.prices.BZUSDT = ['73', '73.01']; };
  await f.step();
  assert.equal(f.jobs.length, 0); assert.deepEqual(f.locks(), []);
  assert.equal(f.rule.state.failures, 0); assert.equal(f.rule.state.phase, 'idle');
  assert.match(f.rule.live.note, /下单前复核盘口：可成交价差已不满足阈值/);
  assert.equal(f.rule.live.hits, 0);
  f.prices.BZUSDT = ['75', '75.01'];
  await f.step();
  assert.equal(f.jobs.length, 1);
});

test('a reconnect while holding sends the rule to review instead of closing on the new connection', async t => {
  const f = await fixture(t);
  enable(f);
  await f.step(); await f.step(); await f.settle(); await f.auto.tick();
  assert.equal(f.rule.state.phase, 'holding');
  const revision = f.execution.state().connections.find(row => row.exchange === 'binance').revision;
  await f.execution.connect('binance', { revision, accountMode: 'standard', apiKey: 'fixture_other_key', apiSecret: 'fixture_other_secret' });
  f.prices.BZUSDT = ['71.5', '71.51'];
  await f.step(); await f.step();
  assert.equal(f.rule.state.phase, 'review'); assert.equal(f.rule.enabled, false);
  assert.match(f.rule.state.reason, /实盘连接已更换或断开/);
  assert.equal(f.jobs.length, 1);
  assert.equal([...f.records.values()].filter(record => record.reduceOnly).length, 0);
});

test('a trigger in flight when the service stops creates no job', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 1 }), enabled: true, confirmLive: true });
  f.hooks.account = () => { f.hooks.account = null; f.auto.stop(); };
  await f.step();
  assert.equal(f.jobs.length, 0); assert.deepEqual(f.locks(), []);
  assert.equal(f.rule.state.phase, 'idle'); assert.equal(f.rule.state.failures, 0); assert.equal(f.rule.state.opensToday, 0);
});

test('a reading older than the book limit is never shown as meeting the threshold', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 3 }), enabled: true, confirmLive: true });
  await f.step();
  assert.equal(f.rule.live.met, true); assert.equal(f.rule.live.hits, 1);
  f.advance(10_001);
  assert.equal(f.rule.live.met, false); assert.equal(f.rule.live.hits, 0); assert.match(f.rule.live.note, /未更新/);
});

test('a job whose first batch no longer meets the threshold ends unsent and the rule waits again', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 1 }), enabled: true, confirmLive: true });
  await f.auto.tick(); f.advance(3000); await f.auto.tick();
  assert.equal(f.jobs.length, 1); assert.equal(f.rule.state.opensToday, 1);
  // The spread falls between job creation and the executor's send.
  f.prices.BZUSDT = ['72', '72.01'];
  await f.execution.tick();
  assert.equal(f.jobs[0].status, 'stopped'); assert.equal(f.jobs[0].auto.unsent, true);
  assert.match(f.jobs[0].reason, /发送前复核：可成交价差已不满足阈值，未发送任何委托/);
  assert.equal(f.records.size, 0); assert.deepEqual(f.locks(), []);
  await f.auto.tick();
  assert.equal(f.rule.state.phase, 'idle'); assert.equal(f.rule.enabled, true); assert.equal(f.rule.state.opensToday, 0);
});

test('a book read seconds before the other leg is never paired with it at send time', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 1 }), enabled: true, confirmLive: true });
  await f.auto.tick(); f.advance(3000); await f.auto.tick();
  assert.equal(f.jobs.length, 1);
  f.hooks.market = async symbol => { if (symbol === 'CLUSDT') { await new Promise(resolve => setTimeout(resolve, 5)); f.advance(2000); } };
  await f.execution.tick();
  assert.equal(f.jobs[0].status, 'stopped'); assert.match(f.jobs[0].reason, /两腿盘口读取间隔过长/);
  assert.equal(f.records.size, 0); assert.deepEqual(f.locks(), []);
});

test('a later batch waits while the spread is outside the threshold', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 1, batchCount: 2 }), enabled: true, confirmLive: true });
  await f.auto.tick(); f.advance(3000); await f.auto.tick();
  await f.execution.tick();
  assert.equal(f.records.size, 2);
  for (const record of f.records.values()) Object.assign(record, { filledQuantity: record.quantity, terminal: true, childrenSettled: true, status: 'terminal' });
  f.accounts.binance.positions = [{ symbol: 'BZUSDT', side: 'short', quantity: '0.5' }, { symbol: 'CLUSDT', side: 'long', quantity: '0.5' }];
  await f.execution.tick();
  assert.equal(f.jobs[0].batchIndex, 1);
  f.prices.BZUSDT = ['72', '72.01'];
  f.advance(1000); await f.execution.tick();
  assert.equal(f.records.size, 2, 'second batch is held back'); assert.equal(f.jobs[0].status, 'running');
  f.prices.BZUSDT = ['75', '75.01'];
  f.advance(1000); await f.execution.tick();
  assert.equal(f.records.size, 4);
});

test('with shared account write protection a rule opens and closes through the guarded send path', async t => {
  const f = await fixture(t, { guarded: true });
  enable(f);
  await f.step(); await f.step(); await f.settle(); await f.auto.tick();
  assert.equal(f.rule.state.phase, 'holding');
  f.prices.BZUSDT = ['71.5', '71.51'];
  await f.step(); await f.step(); await f.settle(); await f.auto.tick();
  assert.equal(f.rule.state.phase, 'idle'); assert.equal(f.records.size, 4);
  assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
});

test('automatic orders carry the batch limits and stop chasing at them', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 1 }), enabled: true, confirmLive: true });
  await f.auto.tick(); f.advance(3000); await f.auto.tick();
  await f.execution.tick();
  const bySymbol = symbol => [...f.records.values()].find(record => record.symbol === symbol);
  assert.equal(bySymbol('BZUSDT').stopPrice, '74.51'); assert.equal(bySymbol('CLUSDT').stopPrice, '70.51');
  // Binance legs rest at the checked maker price, which the venue cannot move past the limit.
  assert.equal(bySymbol('BZUSDT').limitPrice, '75.01'); assert.equal(bySymbol('CLUSDT').limitPrice, '70');
  // BZ falls to its limit: the sell order keeps its price. CL moves within its limit and is chased.
  f.prices.BZUSDT = ['74.4', '74.41']; f.prices.CLUSDT = ['70.2', '70.21'];
  f.advance(1000); await f.execution.tick();
  assert.deepEqual(f.hooks.amends, ['CLUSDT']); assert.equal(f.hooks.amendSpecs[0].limitPrice, '70.2');
  assert.equal(f.jobs[0].status, 'running');
  assert.ok(f.execution.jobView(f.jobs[0].id) && f.db.prepare('SELECT json FROM execution_jobs').get().json.includes('已到本批价差界限'));
});

test('a send refused by lost write ownership sends nothing', async t => {
  const f = await fixture(t, { guarded: true });
  f.auto.create({ config: config({ confirmSamples: 1 }), enabled: true, confirmLive: true });
  await f.auto.tick(); f.advance(3000); await f.auto.tick();
  assert.equal(f.jobs.length, 1);
  // Ownership is lost after the executor's own checks, inside the client call: only the send guard can refuse.
  let attempts = 0;
  f.hooks.create = () => { attempts++; f.writer.retired = true; };
  await f.execution.tick();
  assert.ok(attempts >= 1); assert.equal(f.records.size, 0);
  assert.notEqual(f.jobs[0].status, 'completed');
});

test('maintenance outranks every trigger', async t => {
  const f = await fixture(t, { maintenance: true });
  enable(f);
  for (let i = 0; i < 4; i++) await f.step();
  assert.equal(f.jobs.length, 0); assert.match(f.rule.live.note, /系统更新中/);
});

test('a rule changed while the books were read creates no job and no lock', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 1 }), enabled: true, confirmLive: true });
  f.hooks.account = () => { f.hooks.account = null; f.auto.act(f.rule.id, 'disable', { revision: f.rule.revision }); };
  await f.step();
  assert.equal(f.jobs.length, 0); assert.deepEqual(f.locks(), []);
  assert.equal(f.rule.state.phase, 'idle'); assert.equal(f.rule.state.failures, 0);
});

test('refusals before any order back off and disable the rule after three attempts', async t => {
  const f = await fixture(t);
  f.auto.create({ config: config({ confirmSamples: 1 }), enabled: true, confirmLive: true });
  f.accounts.binance.openOrders = [{ id: 'manual', symbol: 'BZUSDT' }];
  await f.step();
  assert.equal(f.rule.state.failures, 1); assert.match(f.rule.state.reason, /本任务之外的活动委托/);
  await f.step();
  assert.equal(f.rule.state.failures, 1, 'waits before trying again');
  await f.wait(30_000); await f.step();
  await f.wait(30_000); await f.step();
  assert.equal(f.rule.state.failures, 3); assert.equal(f.rule.enabled, false); assert.equal(f.rule.state.phase, 'idle');
  assert.equal(f.jobs.length, 0); assert.equal(f.records.size, 0);
});

test('only one running or holding rule per venue and market, and live trading needs confirmation', async t => {
  const f = await fixture(t);
  assert.throws(() => f.auto.create({ config: config(), enabled: true }), /确认规则会自动实盘下单/);
  enable(f);
  assert.throws(() => f.auto.create({ config: config({ direction: 'long', openThreshold: '1', closeThreshold: '3' }), enabled: true, confirmLive: true }), /只能有一条/);
  const state = f.auto.create({ config: config({ exchange: 'bybit' }) });
  assert.equal(state.rules.length, 2); assert.equal(state.rules[1].enabled, false);
  const first = f.rule;
  assert.throws(() => f.auto.update(first.id, { revision: first.revision + 1, config: config() }), /已被更新/);
});

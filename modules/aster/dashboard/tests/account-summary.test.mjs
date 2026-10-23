import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountSummaryView } from '../lib/account-summary.ts';

const now = 1_750_000_000;
const balance = (timestamp = now, equity = '1000', available = '800') => ({
  timestamp,
  equity,
  available,
  wallet: '1000',
});
function fixture() {
  const account = {
    id: 'a',
    enabled: false,
    status: 'error',
    reason: '历史交易快照已过期',
    snapshot_refresh: { interval_seconds: 5 },
    snapshot: {
      timestamp: now - 10800,
      equity: '51004.97',
      available: '8809.94',
      ratio: '0.8027',
      positions: [],
    },
  };
  const pair = {
    id: 'pair',
    long_account_id: 'a',
    short_account_id: 'b',
    enabled: true,
    ordinary: { enabled: false },
    margin: { enabled: true, check_interval_seconds: 5 },
    state: {
      phase: 'monitoring',
      updated_at: now,
      pending: null,
      progress: { quantities: { LONG: '0', SHORT: '0' } },
      margin_balances: { long: balance(), short: balance(now, '2000', '1600') },
      margin: {
        enabled: true,
        status: 'waiting',
        reason: '余额差额未达到阈值',
        blocks_trading: false,
        error: null,
        api_notice: null,
        checked_at: now,
        next_check_at: now + 5,
        cooldown_until: 0,
      },
    },
  };
  return { account, pair };
}

test('funds-only summary uses the selected member balance and does not borrow old risk fields', () => {
  const { account, pair } = fixture(),
    before = structuredClone({ account, pair });
  let view = accountSummaryView(account, pair, now);
  assert.equal(view.fundsOnly, true);
  assert.deepEqual(view.snapshot, {
    timestamp: now,
    equity: '1000',
    available: '800',
    ratio: null,
  });
  assert.equal(view.warning, false);
  assert.equal(view.label, '余额已同步');
  assert.equal(view.elapsed, '0 秒前');
  view = accountSummaryView({ ...account, id: 'b' }, pair, now);
  assert.equal(view.snapshot.equity, '2000');
  assert.equal(view.snapshot.available, '1600');
  assert.deepEqual({ account, pair }, before);
});

test('standalone, unrelated, ordinary accounts retain the full snapshot and original warning', () => {
  const { account, pair } = fixture();
  for (const binding of [
    undefined,
    { ...pair, long_account_id: 'c' },
    { ...pair, ordinary: { enabled: true } },
    { ...pair, ordinary: {} },
    { ...pair, margin: { enabled: false } },
  ]) {
    const view = accountSummaryView(account, binding, now);
    assert.equal(view.fundsOnly, false);
    assert.equal(view.snapshot, account.snapshot);
    assert.equal(view.warning, true);
  }
});

test('missing funds are unavailable even when the old trading snapshot has values', () => {
  const { account, pair } = fixture();
  delete pair.state.margin_balances.long;
  const view = accountSummaryView(account, pair, now);
  assert.equal(view.snapshot, undefined);
  assert.equal(view.label, '等待保证金余额');
  assert.equal(view.fresh, false);
  assert.equal(account.snapshot.equity, '51004.97');
});

test('invalid balance fields remain unknown and cannot be labelled successful', () => {
  const { account, pair } = fixture();
  for (const invalid of [null, undefined, '', 'NaN', 'Infinity', true]) {
    pair.state.margin_balances.long.available = invalid;
    const view = accountSummaryView(account, pair, now);
    assert.equal(view.snapshot.available, undefined);
    assert.equal(view.snapshot.equity, '1000');
    assert.equal(view.warning, true);
    assert.match(view.notice, /不完整/);
  }
  pair.state.margin_balances.long = balance(now, '-10', '0');
  assert.equal(accountSummaryView(account, pair, now).warning, false);
});

test('planned checks and cooldown keep original timestamps without implying a fresh read', () => {
  const { account, pair } = fixture();
  pair.state.updated_at = now + 10;
  let view = accountSummaryView(account, pair, now + 10);
  assert.equal(view.warning, false);
  assert.equal(view.label, '正在检查余额');
  assert.equal(view.fresh, false);
  assert.equal(view.snapshot.timestamp, now);
  pair.state.updated_at = now + 20;
  pair.state.margin.status = 'cooldown';
  pair.state.margin.cooldown_until = now + 30;
  view = accountSummaryView(account, pair, now + 20);
  assert.equal(view.warning, false);
  assert.match(view.label, /冷却中/);
  assert.equal(view.snapshot.timestamp, now);
  pair.state.updated_at = now + 50;
  view = accountSummaryView(account, pair, now + 50);
  assert.equal(view.warning, true);
  assert.match(view.label, /更新延迟/);
});

test('stopped runtime cannot use a planned wait to hide old balances', () => {
  const { account, pair } = fixture();
  pair.state.margin.next_check_at = now + 300;
  const view = accountSummaryView(account, pair, now + 20);
  assert.equal(view.warning, true);
  assert.match(view.notice, /长时间未更新/);
  assert.equal(view.snapshot.timestamp, now);
});

test('durable soft failures and API errors override fresh balances and planned waits', () => {
  for (const mode of ['soft', 'api', 'blocked', 'unknown', 'pair']) {
    const { account, pair } = fixture();
    if (mode === 'soft')
      pair.state.margin.error = '本轮保证金检查已跳过；HTTP 500';
    if (mode === 'api')
      pair.state.margin.api_notice = { kind: 'budget', text: 'API 预算不足' };
    if (mode === 'blocked' || mode === 'unknown')
      Object.assign(pair.state.margin, {
        status: mode,
        reason: '保证金检查异常',
      });
    if (mode === 'pair')
      pair.state.api_notice = { kind: 'rate_limit', text: 'API 限速' };
    const view = accountSummaryView(account, pair, now + 1);
    assert.equal(view.warning, true, mode);
    assert.match(view.label, /检查异常/, mode);
    assert.ok(view.notice, mode);
    assert.equal(view.snapshot.timestamp, now);
  }
});

test('normal acknowledged transfers are not failures and a successful next check clears the error', () => {
  const { account, pair } = fixture();
  Object.assign(pair.state.margin, {
    status: 'acknowledged',
    blocks_trading: true,
    pending: { status: 'acknowledged' },
    error: null,
  });
  assert.equal(accountSummaryView(account, pair, now + 1).warning, false);
  pair.state.margin.error = 'HTTP 500';
  assert.equal(accountSummaryView(account, pair, now + 1).warning, true);
  pair.state.margin.error = null;
  assert.equal(accountSummaryView(account, pair, now + 1).warning, false);
});

test('paused balances are explicit retained records and cannot conceal failures or disconnection', () => {
  const { account, pair } = fixture();
  pair.enabled = false;
  let view = accountSummaryView(account, pair, now + 10800);
  assert.equal(view.warning, false);
  assert.match(view.label, /配对组已暂停/);
  assert.equal(view.snapshot.timestamp, now);
  view = accountSummaryView(account, pair, now + 10800, '离线');
  assert.equal(view.warning, true);
  assert.match(view.label, /连接异常/);
  pair.state.margin.error = 'HTTP 500';
  view = accountSummaryView(account, pair, now + 10800);
  assert.equal(view.warning, true);
  assert.match(view.notice, /HTTP 500/);
});

test('invalid and future balance times never become healthy scheduled records', () => {
  const { account, pair } = fixture();
  for (const stamp of [0, -1, NaN, Infinity, now + 2]) {
    pair.state.margin_balances.long.timestamp = stamp;
    const view = accountSummaryView(account, pair, now);
    assert.equal(view.warning, true);
    assert.match(view.label, /时间异常/);
  }
});

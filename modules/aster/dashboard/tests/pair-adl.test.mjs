import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adlConfigurationLock,
  adlStartBlock,
  adlRecoveryBlock,
  adlStatus,
  adlNotificationStatus,
  parseAdlConfig,
  parseAdlReport,
} from '../lib/pair-adl.ts';
import {
  pairDraft,
  parsePairDraft,
  pairConfigurationChanges,
  pairConfigurationLock,
  pairStartRecoveryBlock,
  pairDeletionBlock,
  pairExecutionPhaseLabel,
} from '../lib/pairs.ts';

test('ADL amount accepts exact ordinary decimals and rejects values beyond exact bounds', () => {
  for (const value of [
    '1',
    '1.000000000000000001',
    '0001.50',
    '1000',
    '1000000.00000000000000000000000000000000',
  ]) {
    assert.equal(parseAdlConfig(false, value).batch_notional, value);
  }
  for (const value of [
    '0',
    '0.999999999999999999',
    '1000000.000000000000000001',
    '-1',
    '1e3',
    '+2',
    '.5',
    '1.',
    'Infinity',
    '１',
    '1_000',
    '1,000',
    '1'.repeat(41),
    '',
  ]) {
    assert.throws(() => parseAdlConfig(true, value));
  }
  assert.throws(() => parseAdlConfig('false', '1000'));
});

test('legacy pair defaults and explicit disabled config round trip through saved configuration', () => {
  const accounts = [
    { id: 'a', mode: 'paper', enabled: false },
    { id: 'b', mode: 'paper', enabled: false },
  ];
  const draft = {
    ...pairDraft(),
    id: 'pair',
    name: '配对',
    long_account_id: 'a',
    short_account_id: 'b',
  };
  assert.equal(draft.adl_enabled, true);
  assert.equal(draft.adl_batch_notional, '1000');
  const pair = parsePairDraft(
    { ...draft, adl_enabled: false, adl_batch_notional: '250.000000000001' },
    accounts,
    [],
  );
  assert.deepEqual(pairConfigurationChanges(pair).adl, {
    enabled: false,
    batch_notional: '250.000000000001',
  });
  assert.equal(pairDraft(pair).adl_enabled, false);
  assert.equal(pairDraft(pair).adl_batch_notional, '250.000000000001');
  assert.throws(
    () => parsePairDraft({ ...draft, adl_batch_notional: '1e3' }, accounts, []),
    /ADL/,
  );
});

const pairWith = (status, hold = true) => ({
  enabled: false,
  ordinary: { enabled: false },
  cycle: { enabled: false },
  margin: { enabled: true },
  state: {
    adl: {
      configuration_locked: hold,
      lock_reason: 'ADL 观察锁',
      incident: { id: 'i', status, hold },
    },
  },
});
test('active and blocked ADL prevent activation even in funds-only mode and prevent mutations', () => {
  for (const status of ['active', 'blocked']) {
    const pair = pairWith(status);
    assert.match(adlStartBlock(pair), /尚未完成/);
    assert.match(pairStartRecoveryBlock(pair), /ADL/);
    assert.match(pairConfigurationLock(pair), /ADL/);
    assert.match(pairDeletionBlock(pair, 100), /ADL/);
    assert.match(pairExecutionPhaseLabel(pair), /ADL/);
  }
});
test('completed hold permits manual activation but holds configuration and deletion until released', () => {
  const pair = pairWith('completed');
  assert.equal(adlStartBlock(pair), '');
  assert.equal(pairStartRecoveryBlock(pair), '');
  assert.match(adlConfigurationLock(pair), /ADL/);
  assert.match(pairDeletionBlock(pair, 100), /ADL/);
  assert.match(pairExecutionPhaseLabel(pair), /保持暂停/);
  assert.equal(adlConfigurationLock(pairWith('completed', false)), '');
  assert.match(
    adlConfigurationLock({
      state: {
        adl: {
          configuration_locked: true,
          incident: null,
          lock_reason: '等待确认新事件',
        },
      },
    }),
    /等待确认/,
  );
});
test('ordinary configuration locks do not masquerade as an ADL recovery lock', () => {
  assert.equal(
    adlRecoveryBlock({
      state: {
        adl: {
          configuration_locked: true,
          pending_event: false,
          incident: null,
          lock_reason: '原订单待核实',
        },
      },
    }),
    false,
  );
  const pending = {
    state: {
      adl: { configuration_locked: true, pending_event: true, incident: null },
    },
  };
  assert.equal(adlRecoveryBlock(pending), true);
  assert.match(adlStartBlock(pending), /确认现场/);
  assert.equal(adlRecoveryBlock(pairWith('completed', true)), true);
  assert.equal(adlRecoveryBlock(pairWith('completed', false)), false);
});
test('offline status cannot present a stale healthy monitor or completed incident as current', () => {
  const state = { monitoring: { status: 'monitoring' }, incident: null };
  assert.equal(adlStatus(state).label, '定期补查正常');
  assert.equal(
    adlStatus({ ...state, incident: { status: 'completed' } }, true).label,
    '连接中断 · 最近记录',
  );
  assert.equal(
    adlStatus({ monitoring: { status: 'degraded' } }).attention,
    true,
  );
  assert.equal(adlStatus(undefined).label, '等待 ADL 状态');
  assert.equal(
    adlStatus({ id: 'legacy', status: 'active' }).label,
    '等待 ADL 状态',
  );
  assert.equal(
    adlStatus({ ...state, pending_event: true }).label,
    '已收到 ADL · 等待核实',
  );
  assert.equal(
    adlStatus({ ...state, pending_event: true, incident: { status: 'active' } })
      .label,
    '正在处理 ADL',
  );
  assert.equal(
    adlStatus({
      ...state,
      pending_event: true,
      incident: { status: 'blocked' },
    }).label,
    'ADL 处理受阻',
  );
  assert.equal(
    adlStatus({
      ...state,
      pending_event: true,
      incident: { status: 'completed' },
    }).label,
    '已收到 ADL · 等待核实',
  );
});
test('ADL notices use the event robot and respect the global toggle', () => {
  const notification = {
    configured: true,
    pending: 0,
    channels: { scheduled: { configured: true }, event: { configured: false } },
  };
  assert.match(adlNotificationStatus(notification, true), /事件机器人未配置/);
  assert.match(adlNotificationStatus(notification, false), /总开关已关闭/);
  assert.match(
    adlNotificationStatus(
      {
        ...notification,
        channels: { event: { configured: true, error: '投递失败' } },
      },
      true,
    ),
    /投递失败/,
  );
});
test('report replies are bound to the selected pair and incident and retain unknown evidence', () => {
  const report = {
    pair_id: 'p',
    incident_id: 'i',
    status: 'blocked',
    generated_at: 100,
    messages: ['原单回执 UNKNOWN；未确认最终成交量', '当前总多空仍不平衡'],
  };
  assert.deepEqual(parseAdlReport(report, 'p', 'i').messages, report.messages);
  assert.throws(() => parseAdlReport(report, 'other', 'i'), /事件已变化/);
  assert.throws(() => parseAdlReport(report, 'p', 'new'), /事件已变化/);
  for (const patch of [
    { messages: [] },
    { messages: [''] },
    { generated_at: NaN },
    { status: 'success' },
  ])
    assert.throws(() => parseAdlReport({ ...report, ...patch }, 'p', 'i'));
});

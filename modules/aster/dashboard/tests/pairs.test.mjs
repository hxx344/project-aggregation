import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  availablePairAccounts,
  pairConfigurationChanges,
  pairConfigurationLock,
  pairDataFresh,
  pairDeletionBlock,
  pairDraft,
  pairExecutionPhaseLabel,
  pairHasPending,
  pairMarginStatus,
  pairMarginRunning,
  pairPhaseLabel,
  pairStartBlock,
  pairTransferStatus,
  parsePairDraft,
} from '../lib/pairs.ts';

test('margin runtime state stays independent from strategy activation and saved configuration', () => {
  const fixture = {
    enabled: false,
    margin: { enabled: true },
    state: { margin: { running: true } },
  };
  assert.equal(pairMarginRunning(fixture), true);
  fixture.state.margin.running = false;
  assert.equal(pairMarginRunning(fixture), false);
  fixture.enabled = true;
  assert.equal(pairMarginRunning(fixture), false);
  delete fixture.state.margin.running;
  assert.equal(pairMarginRunning(fixture), true);
  fixture.enabled = false;
  assert.equal(pairMarginRunning(fixture), false);
  fixture.enabled = true;
  fixture.margin.enabled = false;
  assert.equal(pairMarginRunning(fixture), false);
});

test('start requires margin balancing but never waits for a pending transfer', () => {
  const fixture = {
    enabled: false,
    margin: { enabled: true },
    state: {
      margin: { status: 'unknown', pending: { request_id: 'original' } },
    },
  };
  assert.equal(pairStartBlock(fixture), '');
  assert.match(pairConfigurationLock(fixture), /划转结果待核对/);
  assert.match(pairDeletionBlock(fixture), /划转结果待核实/);
  assert.equal(
    pairStartBlock({ ...fixture, margin: { enabled: false } }),
    '请先开启保证金平衡，再启动配对组',
  );
  assert.equal(
    pairStartBlock({ ...fixture, margin: {} }),
    '请先开启保证金平衡，再启动配对组',
  );
});

test('transfer submission is distinct from order submission and margin checks need no pending transfer', () => {
  assert.equal(pairPhaseLabel('submitting'), 'submitting');
  assert.equal(
    pairTransferStatus({ status: 'submitting' }),
    '划转请求提交中 · 等待回执',
  );
  assert.equal(
    pairMarginStatus({ status: 'submitting' }),
    '划转请求提交中 · 等待回执',
  );
  assert.equal(pairPhaseLabel('margin_wait'), '保证金检查阻止新增');
  assert.equal(pairHasPending({ state: { phase: 'margin_wait' } }), false);
});

test('legacy order records stay pending and block start, edits and deletion', () => {
  for (const legacy of [
    { pending: { id: 'old-batch', kind: 'ordinary' } },
    { recovery_watch: { batches: [{ id: 'old' }] } },
    // The server refuses any non-null record, even an empty one.
    { pending: {} },
  ]) {
    const fixture = pair({ phase: 'attention', ...legacy });
    fixture.margin.enabled = true;
    assert.equal(pairExecutionPhaseLabel(fixture), '需要处理');
    assert.equal(pairHasPending(fixture), true);
    assert.match(pairStartBlock(fixture), /旧版配对开仓.*暂不能启动/);
    assert.match(pairConfigurationLock(fixture), /旧版配对开仓.*修改设置/);
    assert.match(pairDeletionBlock(fixture), /旧版配对开仓.*暂不能删除/);
  }
  for (const empty of [{ pending: null }, {}]) {
    const fixture = pair(empty);
    assert.equal(pairHasPending(fixture), false);
    assert.equal(pairConfigurationLock(fixture), '');
    assert.equal(pairDeletionBlock(fixture), '');
  }
});

test('funds phases have labels and unknown phases stay visible', () => {
  assert.equal(pairPhaseLabel('maintenance'), '工作台维护中');
  assert.equal(pairPhaseLabel('recovering'), 'ADL 应急处理中');
  assert.equal(pairPhaseLabel('reconciling'), 'reconciling');
  assert.equal(pairPhaseLabel(), '等待状态');
});

const accounts = [
  { id: 'a', name: 'A', mode: 'paper', enabled: false },
  { id: 'b', name: 'B', mode: 'paper', enabled: false },
];
const draft = () => ({
  ...pairDraft(),
  id: 'gold_pair',
  name: '黄金配对',
  long_account_id: 'a',
  short_account_id: 'b',
});
const pair = (state = {}) => ({
  ...parsePairDraft(draft(), accounts, []),
  enabled: false,
  state,
});

test('pair requests carry only funds settings and fixed roles without enabling the group', () => {
  const config = parsePairDraft(draft(), accounts, []);
  assert.equal(config.symbol, 'XAUUSD1');
  assert.equal(config.long_account_id, 'a');
  assert.equal(config.short_account_id, 'b');
  assert.deepEqual(Object.keys(config).sort(), [
    'adl',
    'id',
    'long_account_id',
    'margin',
    'name',
    'short_account_id',
    'symbol',
  ]);
  assert.equal(typeof config.margin.check_interval_seconds, 'number');
  assert.deepEqual(Object.keys(pairConfigurationChanges(config)).sort(), [
    'adl',
    'margin',
    'name',
    'symbol',
  ]);
  // A stored legacy ordinary section is ignored and never sent back.
  const saved = { ...config, enabled: false, ordinary: { enabled: false } };
  const edited = parsePairDraft(pairDraft(saved), accounts, [saved], saved.id);
  assert.equal(Object.hasOwn(edited, 'ordinary'), false);
  assert.equal(Object.hasOwn(pairDraft(saved), 'mode'), false);
});

test('absolute USD1 reserves default off and retain independent exact side values across edits', () => {
  const initial = pairDraft(); assert.equal(initial.absolute_reserve_enabled, false);
  const configured = parsePairDraft({ ...draft(), absolute_reserve_enabled: true, long_reserve: '100.00000001', short_reserve: '200' }, accounts, []);
  assert.equal(configured.margin.long_reserve, '100.00000001'); assert.equal(configured.margin.short_reserve, '200');
  const edited = pairDraft(configured); assert.equal(edited.absolute_reserve_enabled, true);
  assert.equal(parsePairDraft({ ...edited, absolute_reserve_enabled: false }, accounts, []).margin.long_reserve, '100.00000001');
  for (const value of ['-1', 'NaN', '1000000000.00000001']) assert.throws(() => parsePairDraft({ ...draft(), long_reserve: value }, accounts, []));
});

test('pair symbols must come from the catalog unless an edit keeps the saved symbol', () => {
  const symbols = [{ symbol: 'XAGUSD1', display_name: '白银 XAGUSD1' }];
  assert.equal(
    parsePairDraft(
      { ...draft(), symbol: 'XAGUSD1' },
      accounts,
      [],
      undefined,
      symbols,
    ).symbol,
    'XAGUSD1',
  );
  assert.throws(
    () => parsePairDraft(draft(), accounts, [], undefined, symbols),
    /目录中支持的配对标的/,
  );
  const saved = { ...pair(), symbol: 'XAUUSD1' };
  assert.equal(
    parsePairDraft(pairDraft(saved), accounts, [saved], saved.id, symbols)
      .symbol,
    'XAUUSD1',
  );
});

test('membership rejects duplicates, mixed environments, occupied and running accounts', () => {
  assert.throws(
    () => parsePairDraft({ ...draft(), short_account_id: 'a' }, accounts, []),
    /不同/,
  );
  assert.throws(
    () =>
      parsePairDraft(
        draft(),
        [accounts[0], { ...accounts[1], mode: 'live' }],
        [],
      ),
    /相同/,
  );
  assert.throws(
    () => parsePairDraft(draft(), accounts, [{ ...pair(), id: 'other' }]),
    /占用/,
  );
  assert.throws(
    () =>
      parsePairDraft(
        draft(),
        [{ ...accounts[0], enabled: true }, accounts[1]],
        [],
      ),
    /暂停/,
  );
  assert.deepEqual(
    availablePairAccounts(
      [{ ...accounts[0], pair_id: 'unlisted' }, accounts[1]],
      [],
    ).map((account) => account.id),
    ['b'],
  );
  assert.equal(
    availablePairAccounts(accounts, [pair()], 'gold_pair').length,
    2,
  );
});

test('live automatic transfers need a master prefix and meaningful transfer bounds', () => {
  const live = accounts.map((account) => ({ ...account, mode: 'live' }));
  assert.throws(
    () => parsePairDraft({ ...draft(), margin_enabled: true }, live, []),
    /主账户凭据/,
  );
  assert.throws(
    () => parsePairDraft({ ...draft(), min_transfer: '1001' }, accounts, []),
    /不能大于/,
  );
  assert.throws(
    () =>
      parsePairDraft(
        { ...draft(), check_interval_seconds: '1.5' },
        accounts,
        [],
      ),
    /整数秒/,
  );
  assert.throws(
    () => parsePairDraft({ ...draft(), buffer_percent: '100' }, accounts, []),
    /小于 100/,
  );
  assert.throws(
    () =>
      parsePairDraft(
        { ...draft(), check_interval_seconds: '86401' },
        accounts,
        [],
      ),
    /3600/,
  );
  assert.throws(
    () =>
      parsePairDraft({ ...draft(), max_transfer: 'Infinity' }, accounts, []),
    /金额或数值/,
  );
  const config = parsePairDraft(
    {
      ...draft(),
      margin_enabled: true,
      master_env_prefix: 'ASTER_MASTER',
      buffer_percent: '0',
    },
    live,
    [],
  );
  assert.equal(config.margin.buffer_ratio, '0');
  assert.equal(config.margin.master_env_prefix, 'ASTER_MASTER');
});

test('zero balancing threshold survives an edit that only renames the group', () => {
  const saved = {
    ...parsePairDraft({ ...draft(), balance_threshold: '0' }, accounts, []),
    enabled: false,
  };
  const renamed = pairConfigurationChanges(
    parsePairDraft(
      { ...pairDraft(saved), name: '新组名称' },
      accounts,
      [saved],
      saved.id,
    ),
  );
  assert.equal(renamed.name, '新组名称');
  assert.deepEqual(renamed.margin, saved.margin);
  assert.equal(renamed.margin.threshold, '0');
});

test('balancing intervals and cooldowns match their separate server limits', () => {
  for (const [field, maximum] of [
    ['check_interval_seconds', 3600],
    ['cooldown_seconds', 86400],
  ]) {
    for (const value of ['0', '-1', '1.5', String(maximum + 1)])
      assert.throws(
        () => parsePairDraft({ ...draft(), [field]: value }, accounts, []),
        new RegExp(`1 至 ${maximum}`),
      );
    for (const value of ['1', String(maximum)])
      assert.equal(
        parsePairDraft({ ...draft(), [field]: value }, accounts, []).margin[
          field
        ],
        Number(value),
      );
  }
});

test('transfer minimum and maximum compare exact decimals at both boundaries', () => {
  for (const min_transfer of [
    '0.000000001',
    '0.000000009999999999999999999999',
  ])
    assert.throws(
      () => parsePairDraft({ ...draft(), min_transfer }, accounts, []),
      /至少为 0.00000001/,
    );
  for (const value of ['0.00000001', '1000000000']) {
    const config = parsePairDraft(
      { ...draft(), min_transfer: value, max_transfer: value },
      accounts,
      [],
    );
    assert.equal(config.margin.min_transfer, value);
    assert.equal(config.margin.max_transfer, value);
  }
  assert.throws(
    () =>
      parsePairDraft(
        { ...draft(), min_transfer: '1.000000000000000001', max_transfer: '1' },
        accounts,
        [],
      ),
    /不能大于/,
  );
  assert.throws(
    () =>
      parsePairDraft(
        { ...draft(), max_transfer: '1000000000.000000000000000001' },
        accounts,
        [],
      ),
    /不能超过/,
  );
});

test('balancing limits reject decimal overflow without Number rounding', () => {
  for (const [field, value] of [
    ['balance_threshold', '1000000000.000000000000000001'],
    ['buffer_percent', '100.000000000000000001'],
  ])
    assert.throws(() =>
      parsePairDraft({ ...draft(), [field]: value }, accounts, []),
    );

  const config = parsePairDraft(
    {
      ...draft(),
      balance_threshold: '1000000000',
      buffer_percent: '99.999999999999999999',
    },
    accounts,
    [],
  );
  assert.equal(
    config.margin.balance_threshold ?? config.margin.threshold,
    '1000000000',
  );
  assert.equal(config.margin.buffer_ratio, '0.99999999999999999999');
  for (const [field, value] of [
    ['balance_threshold', '0'],
    ['buffer_percent', '0'],
  ])
    assert.doesNotThrow(() =>
      parsePairDraft({ ...draft(), [field]: value }, accounts, []),
    );
});

test('pair amounts respect API string lengths while retaining supported precision', () => {
  for (const field of ['balance_threshold', 'min_transfer', 'max_transfer']) {
    const forty = `1000.${'0'.repeat(35)}`;
    assert.doesNotThrow(() =>
      parsePairDraft({ ...draft(), [field]: forty }, accounts, []),
    );
    assert.throws(
      () => parsePairDraft({ ...draft(), [field]: forty + '0' }, accounts, []),
      /40 个字符/,
    );
  }
  const buffer = `5.${'0'.repeat(126)}`;
  assert.equal(
    parsePairDraft({ ...draft(), buffer_percent: buffer }, accounts, []).margin
      .buffer_ratio,
    '0.05',
  );
  assert.throws(
    () =>
      parsePairDraft(
        { ...draft(), buffer_percent: buffer + '0' },
        accounts,
        [],
      ),
    /128 个字符/,
  );
});

test('buffer conversion rejects expanded precision without rounding positive amounts to zero', () => {
  for (const buffer_percent of [
    `0.${'0'.repeat(125)}1`,
    `0.${'1'.repeat(126)}`,
  ]) {
    assert.equal(buffer_percent.length, 128);
    assert.throws(
      () => parsePairDraft({ ...draft(), buffer_percent }, accounts, []),
      /风险约束精度超出范围/,
    );
  }
  const smallest = parsePairDraft(
    { ...draft(), buffer_percent: `0.${'0'.repeat(97)}1` },
    accounts,
    [],
  ).margin.buffer_ratio;
  assert.equal(smallest, `0.${'0'.repeat(99)}1`);
  assert.ok(smallest.length <= 128);
  assert.throws(
    () =>
      parsePairDraft(
        { ...draft(), buffer_percent: `0.${'0'.repeat(98)}1` },
        accounts,
        [],
      ),
    /风险约束精度超出范围/,
  );
  const padded = `0.1${'0'.repeat(125)}`;
  assert.equal(padded.length, 128);
  assert.equal(
    parsePairDraft({ ...draft(), buffer_percent: padded }, accounts, []).margin
      .buffer_ratio,
    '0.001',
  );
});

test('every live group requires an independent master prefix on create and edit even when balancing is disabled', () => {
  const live = accounts.map((account) => ({
    ...account,
    mode: 'live',
    env_prefix: `ASTER_${account.id.toUpperCase()}`,
  }));
  {
    for (const currentId of [undefined, 'gold_pair']) {
      const input = { ...draft(), margin_enabled: false };
      assert.throws(
        () => parsePairDraft(input, live, [], currentId),
        /实盘配对组须填写独立主账户/,
      );
      for (const master_env_prefix of ['ASTER_A', 'ASTER_B']) {
        assert.throws(
          () =>
            parsePairDraft(
              { ...input, master_env_prefix },
              live,
              [],
              currentId,
            ),
          /不能使用任一子账户/,
        );
      }
      const saved = parsePairDraft(
        { ...input, master_env_prefix: 'ASTER_MASTER' },
        live,
        [],
        currentId,
      );
      assert.equal(saved.margin.enabled, false);
      assert.equal(saved.margin.master_env_prefix, 'ASTER_MASTER');
    }
  }
  assert.equal(
    parsePairDraft(draft(), accounts, []).margin.master_env_prefix,
    '',
  );
});

test('transfer statuses distinguish exchange acknowledgement, refreshed balances and independently verified income', () => {
  const acknowledged = {
    request_id: 'r',
    source: 'long',
    destination: 'short',
    amount: '10',
    created_at: 90,
    status: 'acknowledged',
    acknowledged_at: 100,
  };
  assert.match(pairTransferStatus(acknowledged), /等待余额刷新/);
  assert.match(
    pairMarginStatus({
      status: 'acknowledged',
      pending: acknowledged,
      last_transfer: acknowledged,
    }),
    /等待余额刷新/,
  );
  const refreshed = { ...acknowledged, refreshed_at: 101 };
  assert.equal(pairTransferStatus(refreshed), '交易所回执确认，余额已刷新');
  assert.equal(
    pairMarginStatus({
      status: 'acknowledged',
      pending: null,
      last_transfer: refreshed,
    }),
    '交易所回执确认，余额已刷新',
  );
  assert.equal(
    pairTransferStatus({ ...refreshed, status: 'refreshed' }),
    '交易所回执确认，余额已刷新',
  );
  assert.match(
    pairTransferStatus({ ...refreshed, status: 'confirmed' }),
    /两侧划转流水已核实/,
  );
  assert.match(
    pairTransferStatus({ ...refreshed, status: 'unknown' }),
    /结果未知/,
  );
  assert.match(
    pairTransferStatus({ ...acknowledged, refreshed_at: NaN }),
    /等待余额刷新/,
  );
});

test('snapshot freshness handles exact 8-second boundary, offline and invalid clocks', () => {
  assert.equal(pairDataFresh(100, 107.99), true);
  for (const [time, now, offline] of [
    [100, 108, false],
    [100, 101, true],
    [undefined, 100, false],
    [102, 100, false],
    [100, NaN, false],
  ])
    assert.equal(pairDataFresh(time, now, offline), false);
});

test('unknown transfers block edits and deletion without claiming completion', () => {
  for (const state of [
    { margin: { status: 'unknown' } },
    { margin: { pending: { request_id: 'r' } } },
  ]) {
    assert.equal(pairHasPending(pair(state)), true);
    assert.match(pairConfigurationLock(pair(state)), /待核对/);
    assert.match(pairDeletionBlock(pair(state)), /划转结果待核实/);
  }
  for (const status of ['submitting', 'accepted', 'acknowledged'])
    assert.match(
      pairDeletionBlock(pair({ margin: { status } })),
      /划转结果待核实/,
    );
  assert.equal(
    pairDeletionBlock(pair({ margin: { status: 'confirmed' } })),
    '',
  );
});

test('deletion keeps both accounts positions and only waits for pause, ADL and transfers', () => {
  // Positions are never inspected: unbinding leaves both accounts as they are.
  const holding = pair({
    display_positions: {
      long: {
        snapshot: {
          timestamp: 100,
          positions: [{ symbol: 'XAUUSD1', side: 'LONG', qty: '5' }],
        },
      },
    },
  });
  assert.equal(pairDeletionBlock(holding), '');
  assert.match(pairDeletionBlock({ ...pair(), enabled: true }), /暂停/);
  assert.match(pairDeletionBlock(pair(), true), /连接恢复/);
  assert.match(
    pairDeletionBlock(
      pair({ adl: { configuration_locked: true, lock_reason: 'ADL 处理中' } }),
    ),
    /ADL/,
  );
});

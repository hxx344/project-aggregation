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
  pairMarginOnly,
  pairNetQuantity,
  pairPhaseLabel,
  pairSnapshotStatus,
  pairStartRecoveryBlock,
  pairTransferStatus,
  parsePairDraft,
} from '../lib/pairs.ts';

test('funds-only activation keeps pending recovery separate from trading activation', () => {
  const fixture = {
    ordinary: { enabled: false },
    cycle: { enabled: false },
    margin: { enabled: true },
    state: {
      pending: { kind: 'leverage' },
      progress: { quantities: { LONG: '7' } },
      margin: { status: 'unknown', pending: { request_id: 'original' } },
    },
  };
  assert.equal(pairMarginOnly(fixture), true);
  assert.equal(pairStartRecoveryBlock(fixture), '');
  assert.match(pairConfigurationLock(fixture), /待核对/);
  assert.match(pairDeletionBlock(fixture, 100), /等待确认/);
  assert.match(
    pairStartRecoveryBlock({ ...fixture, ordinary: { enabled: true } }),
    /待核对/,
  );
});

test('transfer submission is distinct from order submission and margin checks need no pending transfer', () => {
  assert.equal(pairPhaseLabel('submitting'), '并行提交两侧市价单');
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

test('leverage confirmation is distinct from order reconciliation without changing pending locks', () => {
  for (const phase of ['leverage', 'reconciling']) {
    const fixture = pair({
      phase,
      pending: { id: 'leverage-one', kind: 'leverage' },
    });
    assert.equal(pairExecutionPhaseLabel(fixture), '杠杆设置确认中');
    assert.equal(pairHasPending(fixture), true);
    assert.ok(pairConfigurationLock(fixture));
    assert.ok(pairStartRecoveryBlock(fixture));
    assert.ok(pairDeletionBlock(fixture, 100));
  }
  assert.equal(
    pairExecutionPhaseLabel(
      pair({ phase: 'reconciling', pending: { kind: 'ordinary' } }),
    ),
    '订单结果核对中',
  );
  assert.equal(
    pairExecutionPhaseLabel(
      pair({ phase: 'attention', pending: { kind: 'leverage' } }),
    ),
    '需要处理',
  );
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
const snapshot = (positions = [], timestamp = 100) => ({
  positions,
  timestamp,
});
const position = (side, qty, symbol = 'XAUUSD1') => ({ side, qty, symbol });
const pair = (state = {}) => ({
  ...parsePairDraft(draft(), accounts, []),
  enabled: false,
  state: { snapshots: { long: snapshot(), short: snapshot() }, ...state },
});

test('pair requests preserve decimal strings and fixed roles without enabling the group', () => {
  const config = parsePairDraft(
    {
      ...draft(),
      mode: 'ordinary',
      order_notional: '1000.000000001',
      margin_percent: '50.00001',
    },
    accounts,
    [],
  );
  assert.equal(config.symbol, 'XAUUSD1');
  assert.equal(config.long_account_id, 'a');
  assert.equal(config.short_account_id, 'b');
  assert.equal(config.ordinary.order_notional, '1000.000000001');
  assert.equal(config.ordinary.margin_limit, '0.5000001');
  assert.equal(config.ordinary.enabled, true);
  assert.equal(config.cycle.enabled, false);
  assert.equal(Object.hasOwn(config, 'enabled'), false);
  assert.equal(typeof config.margin.check_interval_seconds, 'number');
  assert.deepEqual(Object.keys(pairConfigurationChanges(config)).sort(), [
    'cycle',
    'margin',
    'name',
    'ordinary',
    'symbol',
  ]);
});

test('trade mode is exclusive and monitor-only does not silently enable trading', () => {
  for (const mode of ['monitor', 'ordinary', 'cycle']) {
    const config = parsePairDraft({ ...draft(), mode }, accounts, []);
    assert.equal(config.ordinary.enabled, mode === 'ordinary');
    assert.equal(config.cycle.enabled, mode === 'cycle');
  }
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
    () => parsePairDraft({ ...draft(), order_notional: '499' }, accounts, []),
    /500/,
  );
  assert.throws(
    () => parsePairDraft({ ...draft(), spread_limit: '0' }, accounts, []),
    /大于零/,
  );
  assert.throws(
    () => parsePairDraft({ ...draft(), spread_limit: '0.001' }, accounts, []),
    /不能超过/,
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
  assert.deepEqual(renamed.ordinary, saved.ordinary);
  assert.deepEqual(renamed.cycle, saved.cycle);
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

test('trading and balancing limits reject decimal overflow without Number rounding', () => {
  for (const [field, value] of [
    ['threshold', '1000000000.000000000000000001'],
    ['balance_threshold', '1000000000.000000000000000001'],
    ['order_notional', '499.999999999999999999'],
    ['order_notional', '1000000.000000000000000001'],
    ['spread_limit', '0.000500000000000000000000000001'],
    ['buffer_percent', '100.000000000000000001'],
  ])
    assert.throws(() =>
      parsePairDraft({ ...draft(), [field]: value }, accounts, []),
    );

  const config = parsePairDraft(
    {
      ...draft(),
      threshold: '1000000000',
      balance_threshold: '1000000000',
      order_notional: '500',
      spread_limit: '0.0005',
      buffer_percent: '99.999999999999999999',
    },
    accounts,
    [],
  );
  assert.equal(config.ordinary.order_notional, '500');
  assert.equal(config.ordinary.spread_limit, '0.0005');
  assert.equal(config.margin.buffer_ratio, '0.99999999999999999999');
  assert.equal(
    parsePairDraft({ ...draft(), order_notional: '1000000' }, accounts, [])
      .ordinary.order_notional,
    '1000000',
  );
  for (const [field, value] of [
    ['threshold', '0'],
    ['balance_threshold', '0'],
    ['buffer_percent', '0'],
  ])
    assert.doesNotThrow(() =>
      parsePairDraft({ ...draft(), [field]: value }, accounts, []),
    );
});

test('pair amounts respect API string lengths while retaining supported precision', () => {
  for (const field of [
    'threshold',
    'order_notional',
    'balance_threshold',
    'min_transfer',
    'max_transfer',
  ]) {
    const forty = `1000.${'0'.repeat(35)}`;
    assert.doesNotThrow(() =>
      parsePairDraft({ ...draft(), [field]: forty }, accounts, []),
    );
    assert.throws(
      () => parsePairDraft({ ...draft(), [field]: forty + '0' }, accounts, []),
      /40 个字符/,
    );
  }
  const spread = `0.0005${'0'.repeat(122)}`;
  assert.equal(
    parsePairDraft({ ...draft(), spread_limit: spread }, accounts, []).ordinary
      .spread_limit,
    spread,
  );
  assert.throws(
    () =>
      parsePairDraft({ ...draft(), spread_limit: spread + '0' }, accounts, []),
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
  for (const mode of ['monitor', 'ordinary', 'cycle']) {
    for (const currentId of [undefined, 'gold_pair']) {
      const input = { ...draft(), mode, margin_enabled: false };
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
  assert.equal(pairSnapshotStatus(undefined, 100), '等待账户数据');
  assert.match(pairSnapshotStatus(snapshot(), 108), /过期/);
  assert.match(pairSnapshotStatus(snapshot(), 101, true), /连接中断/);
});

test('account display cadence cannot extend pair snapshot freshness or a cached deletion block', () => {
  const occupied = pair({
    snapshots: {
      long: snapshot([position('LONG', '1')]),
      short: snapshot(),
    },
  });
  // Replay the proposed cadence argument: it is display metadata, not evidence
  // that a pair snapshot remains current after the eight-second boundary.
  for (const interval of [30, 60, Infinity]) {
    assert.equal(pairDataFresh(100, 107.999, false, interval), true);
    assert.match(
      pairDeletionBlock(occupied, 107.999, false, interval),
      /指定方向仓位/,
    );
    for (const now of [108, 120, 160]) {
      assert.equal(pairDataFresh(100, now, false, interval), false);
      assert.match(
        pairSnapshotStatus(snapshot(), now, false, interval),
        /过期/,
      );
      assert.equal(pairDeletionBlock(occupied, now, false, interval), '');
    }
    assert.match(pairDeletionBlock(occupied, 120, true, interval), /连接恢复/);
  }
});

test('quantity difference stays exact and missing side never becomes zero', () => {
  assert.equal(pairNetQuantity({ long: snapshot(), short: null }), null);
  assert.equal(pairNetQuantity({ long: {}, short: snapshot() }), null);
  assert.equal(
    pairNetQuantity({
      long: snapshot([position('LONG', '0.300000000000000001')]),
      short: snapshot([position('SHORT', '-0.3')]),
    }),
    '0.000000000000000001',
  );
  assert.equal(
    pairNetQuantity({
      long: snapshot([position('LONG', '1'), position('SHORT', '0.1')]),
      short: snapshot([position('SHORT', '1')]),
    }),
    '0',
  );
  assert.equal(
    pairNetQuantity({
      long: snapshot([position('LONG', '8', 'BTCUSDT')]),
      short: snapshot(),
    }),
    null,
  );
  assert.equal(
    pairNetQuantity({
      long: snapshot([position('LONG', 'bad')]),
      short: snapshot(),
    }),
    null,
  );
  assert.equal(pairNetQuantity({ long: snapshot(), short: snapshot() }), null);
  assert.equal(
    pairNetQuantity({
      long: snapshot([position('LONG', '0')]),
      short: snapshot([position('SHORT', '0')]),
    }),
    '0',
  );
});

test('net quantity uses each assigned leg and ignores external positions in both accounts', () => {
  const snapshots = {
    long: snapshot([
      position('LONG', '1.000000000000000001'),
      position('SHORT', '20'),
      position('LONG', '900', 'XAGUSD1'),
    ]),
    short: snapshot([
      position('SHORT', '-1.1'),
      position('LONG', '30'),
      position('SHORT', '800', 'XAGUSD1'),
    ]),
  };
  assert.equal(pairNetQuantity(snapshots), '-0.099999999999999999');
  assert.equal(pairNetQuantity(snapshots, 'XAGUSD1'), '100');
  snapshots.long.positions[1].qty = 'unknown';
  snapshots.short.positions[1].qty = '1000';
  assert.equal(pairNetQuantity(snapshots), '-0.099999999999999999');
});

test('missing, duplicate or malformed assigned legs keep net quantity unknown', () => {
  for (const side of ['long', 'short']) {
    const direction = side === 'long' ? 'LONG' : 'SHORT';
    const opposite = side === 'long' ? 'SHORT' : 'LONG';
    const missing = [
      [],
      [position(opposite, '0')],
      [position(direction, '0', 'XAGUSD1')],
      [position('BOTH', '0')],
      [null],
      [position(direction, '0'), position(direction, '0')],
    ];
    const invalid = [
      'bad',
      '',
      'NaN',
      'Infinity',
      '1e-8',
      undefined,
      null,
      0,
      {},
    ].map((qty) => [position(direction, qty)]);
    for (const rows of [...missing, ...invalid]) {
      const snapshots = {
        long: snapshot([position('LONG', '0')]),
        short: snapshot([position('SHORT', '0')]),
      };
      snapshots[side].positions = rows;
      assert.equal(pairNetQuantity(snapshots), null);
    }
  }
});

test('unknown orders and transfers block edits/deletion without claiming completion', () => {
  for (const state of [
    { pending: { orders: [{ id: 'pending' }] } },
    { margin: { status: 'unknown' } },
    { margin: { pending: { request_id: 'r' } } },
  ]) {
    assert.equal(pairHasPending(pair(state)), true);
    assert.match(pairConfigurationLock(pair(state)), /待核对/);
    assert.match(pairDeletionBlock(pair(state), 100), /等待确认/);
  }
  assert.match(
    pairConfigurationLock(pair({ progress: { quantities: { LONG: '0.01' } } })),
    /基线/,
  );
});

test('ordinary baseline holdings do not lock unrelated configuration edits', () => {
  assert.equal(
    pairConfigurationLock(
      pair({
        owned: { LONG: '1', SHORT: '1' },
        progress: {
          baseline: { LONG: '1', SHORT: '1' },
          quantities: { LONG: '0', SHORT: '0' },
        },
        snapshots: {
          long: snapshot([position('LONG', '1')]),
          short: snapshot([position('SHORT', '1')]),
        },
      }),
    ),
    '',
  );
});

test('ordinary opening can request reconciliation at start without unlocking edits or deletion', () => {
  const fixture = pair({
    pending: {
      id: 'unknown-original',
      kind: 'ordinary',
      phase: 'open',
      legs: [{ receipt: null }],
    },
    snapshots: {
      long: snapshot([position('LONG', '19.5')], 1),
      short: snapshot([position('SHORT', '19.5')], 1),
    },
    progress: { quantities: { LONG: '0', SHORT: '0.000' } },
  });
  assert.equal(pairStartRecoveryBlock(fixture), '');
  assert.equal(pairHasPending(fixture), true);
  assert.match(pairConfigurationLock(fixture), /待核对/);
  assert.match(pairDeletionBlock(fixture, 100), /等待确认/);
  // UI values do not authorize adoption or require reducing larger holdings.
  assert.equal(
    pairStartRecoveryBlock(pair({ pending: fixture.state.pending })),
    '',
  );
  assert.equal(pairStartRecoveryBlock(pair()), '');
});

test('other pending work still blocks start even alongside an ordinary opening', () => {
  const ordinary = { id: 'batch', kind: 'ordinary', phase: 'open' };
  for (const pending of [
    { kind: 'cycle', phase: 'open' },
    { kind: 'ordinary', phase: 'close' },
    { kind: 'leverage' },
    { id: 'unclassified' },
  ])
    assert.match(pairStartRecoveryBlock(pair({ pending })), /批次仍待核对/);
  for (const margin of [
    { pending: { request_id: 'transfer' } },
    ...['submitting', 'accepted', 'acknowledged', 'unknown'].map((status) => ({
      status,
    })),
  ])
    assert.match(
      pairStartRecoveryBlock(pair({ pending: ordinary, margin })),
      /划转/,
    );
  for (const qty of ['0.1', '0.000000000000000000000000001', '-0.1', 'invalid'])
    assert.match(
      pairStartRecoveryBlock(
        pair({ pending: ordinary, progress: { quantities: { LONG: qty } } }),
      ),
      /循环新增仓位/,
    );
  assert.equal(
    pairStartRecoveryBlock(pair({ margin: { status: 'confirmed' } })),
    '',
  );
});

test('unknown transfer with a verified new baseline allows start but retains edit and deletion locks', () => {
  const margin = {
    status: 'unknown',
    pending: { request_id: 'original-transfer', status: 'unknown' },
    blocks_trading: false,
    trading_resume_allowed: true,
  };
  const fixture = pair({ margin });
  assert.equal(pairStartRecoveryBlock(fixture), '');
  assert.equal(pairHasPending(fixture), true);
  assert.match(pairConfigurationLock(fixture), /待核对/);
  assert.match(pairDeletionBlock(fixture, 100), /等待确认/);
  assert.match(pairMarginStatus(margin), /交易/);
  for (const changed of [
    { trading_resume_allowed: false },
    { trading_resume_allowed: undefined },
    { blocks_trading: true },
    { status: 'acknowledged' },
  ])
    assert.match(
      pairStartRecoveryBlock(pair({ margin: { ...margin, ...changed } })),
      /划转/,
    );
  assert.match(
    pairStartRecoveryBlock(pair({ margin, pending: { kind: 'cycle' } })),
    /批次/,
  );
});

test('deletion blocks known positions and defers missing/stale snapshots to the server fresh-read guard', () => {
  assert.equal(pairDeletionBlock(pair(), 100), '');
  assert.match(pairDeletionBlock({ ...pair(), enabled: true }, 100), /暂停/);
  assert.equal(pairDeletionBlock(pair(), 108), '');
  assert.equal(
    pairDeletionBlock(
      pair({ snapshots: { long: snapshot(), short: null } }),
      100,
    ),
    '',
  );
  assert.match(pairDeletionBlock(pair(), 100, true), /连接恢复/);
  assert.equal(
    pairDeletionBlock(
      pair({
        snapshots: {
          long: snapshot(),
          short: snapshot([position('LONG', '1', 'BTCUSDT')]),
        },
      }),
      100,
    ),
    '',
  );
});

test('deletion scopes fresh positions to assigned legs unless a historical watch remains', () => {
  for (const symbol of ['XAUUSD1', 'XAGUSD1']) {
    const snapshots = {
      long: snapshot([
        position('LONG', '0', symbol),
        position('SHORT', '5', symbol),
        position('LONG', '8', 'BTCUSDT'),
      ]),
      short: snapshot([
        position('SHORT', '0', symbol),
        position('LONG', '7', symbol),
        position('SHORT', '9', 'BTCUSDT'),
      ]),
    };
    const fixture = { ...pair({ snapshots }), symbol };
    assert.equal(pairDeletionBlock(fixture, 100), '');
    const watched = {
      ...fixture,
      state: { ...fixture.state, recovery_watch: { batches: [{ id: 'old' }] } },
    };
    assert.match(pairDeletionBlock(watched, 100), /所有仓位/);
    assert.equal(pairDeletionBlock(watched, 108), '');
    for (const side of ['long', 'short']) {
      snapshots[side].positions[0].qty = '0.000000000000000001';
      assert.match(pairDeletionBlock(fixture, 100), /指定方向仓位/);
      snapshots[side].positions[0].qty = '0';
    }
  }
});

test('deletion preserves unknown-data checks for scoped holdings and the default symbol', () => {
  for (const side of ['long', 'short']) {
    const direction = side === 'long' ? 'LONG' : 'SHORT';
    for (const positions of [undefined, {}, [position(direction, 'unknown')]]) {
      const fixture = pair({
        snapshots: {
          long: snapshot(),
          short: snapshot(),
          [side]: { positions, timestamp: 100 },
        },
      });
      delete fixture.symbol;
      assert.match(pairDeletionBlock(fixture, 100), /指定方向仓位/);
      assert.equal(pairDeletionBlock(fixture, 108), '');
    }
  }
});

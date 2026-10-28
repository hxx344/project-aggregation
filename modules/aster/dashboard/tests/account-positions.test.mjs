import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pairedSnapshotRefresh,
  accountPositionsView,
  latestPositionsSnapshot,
  positionLeverageLabel,
  positionProfitClass,
  strategyPositionLabel,
  visiblePositions,
} from '../lib/account-positions.ts';
import { pairDeletionBlock, pairNetQuantity } from '../lib/pairs.ts';

const position = (symbol, side, qty) => ({ symbol, side, qty });
const snapshot = (timestamp, positions = []) => ({ timestamp, positions });

test('latest complete position snapshot is selected without changing its object or source time', () => {
  const older = Object.freeze(snapshot(100, Object.freeze([])));
  const rows = Object.freeze([Object.freeze(position('XAUUSD1', 'LONG', '2'))]);
  const newer = Object.freeze(snapshot(110, rows));
  for (const candidates of [
    [older, newer],
    [newer, older],
  ]) {
    const selected = latestPositionsSnapshot(...candidates);
    assert.equal(selected, newer);
    assert.equal(selected.timestamp, 110);
    assert.equal(selected.positions, rows);
  }
  const sameTime = snapshot(110, [position('XAGUSD1', 'SHORT', '3')]);
  assert.equal(latestPositionsSnapshot(newer, sameTime), newer);
  assert.equal(latestPositionsSnapshot(undefined, null, older), older);
});

test('old position snapshots remain available and genuine newer flat snapshots replace them', () => {
  const old = snapshot(1, [position('XAUUSD1', 'LONG', '2')]);
  assert.equal(latestPositionsSnapshot(old), old);
  assert.equal(old.timestamp, 1);
  const flat = snapshot(2);
  assert.equal(latestPositionsSnapshot(old, flat), flat);
  assert.deepEqual(visiblePositions(flat), []);
});

test('invalid timestamps cannot replace position evidence or be used as a snapshot', () => {
  const valid = snapshot(100, [position('XAGUSD1', 'SHORT', '3')]);
  for (const timestamp of [
    undefined,
    null,
    '200',
    0,
    -1,
    NaN,
    Infinity,
    -Infinity,
    8640000000001,
    Number.MAX_VALUE,
  ]) {
    const invalid = snapshot(timestamp);
    assert.equal(latestPositionsSnapshot(invalid), undefined);
    assert.equal(latestPositionsSnapshot(valid, invalid), valid);
    assert.equal(latestPositionsSnapshot(invalid, valid), valid);
  }
});

test('new balances or malformed position arrays never replace holdings with apparent flatness', () => {
  const holdings = snapshot(100, [position('XAUUSD1', 'LONG', '2')]);
  const balances = {
    timestamp: 200,
    equity: '1000',
    wallet: '1000',
    available: '800',
  };
  for (const incomplete of [
    balances,
    { ...balances, positions: null },
    { ...balances, positions: {} },
    { ...balances, positions: '[]' },
  ]) {
    assert.equal(latestPositionsSnapshot(incomplete), undefined);
    assert.equal(latestPositionsSnapshot(holdings, incomplete), holdings);
    assert.equal(latestPositionsSnapshot(incomplete, holdings), holdings);
  }
  assert.equal(latestPositionsSnapshot(), undefined);
  assert.equal(latestPositionsSnapshot(null, undefined), undefined);
});

test('visible holdings retain every market and both directions while filtering zero quantities', () => {
  const held = [
    position('XAUUSD1', 'LONG', '2'),
    position('XAUUSD1', 'SHORT', '-1'),
    position('XAGUSD1', 'LONG', '3'),
    position('CLUSD1', 'SHORT', '4'),
  ];
  const rows = Object.freeze(
    [
      ...held,
      position('XAGUSD1', 'SHORT', '0'),
      position('BTCUSD1', 'LONG', '0.000'),
      position('BTCUSD1', 'SHORT', '-0'),
    ].map(Object.freeze),
  );
  const source = Object.freeze(snapshot(100, rows));
  const visible = visiblePositions(source);
  assert.deepEqual(visible, held);
  assert.notEqual(visible, rows);
  visible.forEach((row, index) => assert.equal(row, rows[index]));
  assert.equal(source.positions, rows);
  assert.equal(rows.length, 7);
  assert.deepEqual(visiblePositions(undefined), []);
  assert.deepEqual(visiblePositions(null), []);
});

test('unknown numeric quantities stay visible instead of being reported as no holdings', () => {
  const rows = ['unknown', 'NaN', 'Infinity', undefined].map((qty) =>
    position('XAUUSD1', 'LONG', qty),
  );
  assert.deepEqual(visiblePositions(snapshot(100, rows)), rows);
});

test('both sides of the configured symbol receive its marker, but only the assigned leg is owned', () => {
  for (const direction of ['LONG', 'SHORT']) {
    for (const side of ['LONG', 'SHORT', 'BOTH']) {
      assert.deepEqual(
        strategyPositionLabel(
          position('XAGUSD1', side, '1'),
          'XAGUSD1',
          direction,
        ),
        {
          symbolLabel: '当前策略币种',
          directionLabel:
            side === direction
              ? direction === 'LONG'
                ? '本组多仓'
                : '本组空仓'
              : null,
        },
      );
      assert.deepEqual(
        strategyPositionLabel(
          position('XAUUSD1', side, '1'),
          'XAGUSD1',
          direction,
        ),
        { symbolLabel: null, directionLabel: null },
      );
    }
  }
});

test('funds-only groups mark the configured symbol without claiming either trading direction', () => {
  for (const direction of ['LONG', 'SHORT']) {
    for (const side of ['LONG', 'SHORT']) {
      assert.deepEqual(
        strategyPositionLabel(
          position('XAGUSD1', side, '1'),
          'XAGUSD1',
          direction,
          true,
        ),
        { symbolLabel: '配置币种', directionLabel: null },
      );
      assert.deepEqual(
        strategyPositionLabel(
          position('XAUUSD1', side, '1'),
          'XAGUSD1',
          direction,
          true,
        ),
        { symbolLabel: null, directionLabel: null },
      );
    }
  }
});

const displayedPosition = (symbol, side, qty) => ({
  symbol,
  side,
  qty,
  entry: '1.25',
  mark: null,
  leverage: '5',
  notional: null,
  occupied_margin: null,
  unrealized: '0.5',
  liquidation: null,
});
const sevenPositions = () => [
  displayedPosition('OURAUSD1', 'LONG', '1191.36'),
  displayedPosition('OURAUSD1', 'SHORT', '10'),
  displayedPosition('XAUUSD1', 'LONG', '2'),
  displayedPosition('XAGUSD1', 'SHORT', '3'),
  displayedPosition('BTCUSD1', 'LONG', '0.0001'),
  displayedPosition('ETHUSD1', 'SHORT', '0.2'),
  displayedPosition('CLUSD1', 'LONG', '4'),
];
const fundsPair = (now, positions = {}) => ({
  enabled: true,
  symbol: 'XAUUSD1',
  long_account_id: 'a',
  short_account_id: 'b',
  ordinary: { enabled: false },
  margin: { enabled: true, check_interval_seconds: 5 },
  state: {
    phase: 'monitoring',
    updated_at: now,
    pending: null,
    progress: { quantities: { LONG: '0', SHORT: '0' } },
    margin_balances: {
      long: { timestamp: now - 3 },
      short: { timestamp: now - 3 },
    },
    margin: {
      enabled: true,
      status: 'waiting',
      blocks_trading: false,
      checked_at: now - 3,
      next_check_at: now + 2,
      cooldown_until: 0,
    },
    display_positions: positions,
  },
});

test('new account-response holdings replace all three old rows without mixing optional fields', () => {
  const old = snapshot(100, [
    {
      ...displayedPosition('OURAUSD1', 'LONG', '1000'),
      mark: '99',
      leverage: 20,
    },
    position('XAUUSD1', 'LONG', '2'),
    position('XAGUSD1', 'SHORT', '3'),
  ]);
  const fresh = snapshot(120, sevenPositions());
  const account = {
    snapshot: old,
    display_positions: { snapshot: fresh, checked_at: 120 },
  };
  const before = structuredClone(account);
  const view = accountPositionsView({ account, now: 121 });
  assert.equal(view.snapshot, fresh);
  assert.equal(view.positions.length, 7);
  assert.equal(view.positions[0], fresh.positions[0]);
  assert.equal(view.positions[0].qty, '1191.36');
  assert.equal(view.positions[0].mark, null);
  assert.equal(view.positions[0].leverage, '5');
  assert.match(view.fieldNotice, /未提供.*—/);
  assert.deepEqual(account, before);
  assert.equal(account.snapshot, old);
  assert.equal(account.snapshot.positions[0].qty, '1000');
});

test('account and pair displays choose one whole newest snapshot from the correct side', () => {
  const accountSnapshot = snapshot(121, sevenPositions());
  const pairSnapshot = snapshot(122, sevenPositions());
  pairSnapshot.positions[0].qty = '1200';
  const otherSide = snapshot(123, [
    displayedPosition('OTHERUSD1', 'SHORT', '9'),
  ]);
  const account = {
    display_positions: { snapshot: accountSnapshot, checked_at: 121 },
  };
  const pair = fundsPair(123, {
    long: { snapshot: pairSnapshot, checked_at: 122 },
    short: { snapshot: otherSide, checked_at: 123 },
  });
  const view = accountPositionsView({ account, pair, side: 'long', now: 123 });
  assert.equal(view.snapshot, pairSnapshot);
  assert.equal(view.positions.length, 7);
  assert.equal(view.positions[0].qty, '1200');
  assert.ok(view.positions.every((row) => row.symbol !== 'OTHERUSD1'));
  assert.match(view.sourceNote, /随保证金检查更新/);
  assert.equal(
    accountPositionsView({ pair, side: 'short', now: 123 }).snapshot,
    otherSide,
  );
});

test('failed display refresh retains old rows and time while first failure cannot claim flatness', () => {
  const retained = snapshot(120, sevenPositions());
  const account = {
    display_positions: {
      snapshot: retained,
      checked_at: 140,
      error: 'OURAUSD1 数量无效',
    },
  };
  const view = accountPositionsView({ account, now: 140 });
  assert.equal(view.snapshot, retained);
  assert.equal(view.snapshot.timestamp, 120);
  assert.equal(view.positions.length, 7);
  assert.equal(view.warning, true);
  assert.match(view.notice, /持仓更新失败.*OURAUSD1/);
  const empty = accountPositionsView({
    account: { display_positions: { checked_at: 140, error: '持仓列表缺失' } },
    now: 140,
  });
  assert.equal(empty.snapshot, undefined);
  assert.equal(empty.emptyTitle, '账户仓位读取失败');
  assert.notEqual(empty.emptyTitle, '暂无持仓');
});

test('newer successful reads clear older display errors without renewing retained timestamps', () => {
  const old = snapshot(100, sevenPositions());
  const current = snapshot(160, sevenPositions());
  const account = {
    snapshot: old,
    display_positions: {
      snapshot: old,
      checked_at: 150,
      error: '持仓字段无效',
    },
  };
  const pair = fundsPair(161, {
    long: { snapshot: current, checked_at: 160, error: null },
  });
  let view = accountPositionsView({ account, pair, side: 'long', now: 161 });
  assert.equal(view.snapshot, current);
  assert.equal(view.warning, false);
  assert.doesNotMatch(view.notice, /失败|无效/);
  account.snapshot = snapshot(162, sevenPositions());
  view = accountPositionsView({ account, now: 162 });
  assert.equal(view.snapshot, account.snapshot);
  assert.equal(view.warning, false);
  assert.equal(account.display_positions.snapshot.timestamp, 100);
});

test('scheduled checks and cooldown retain the real source time without short-lived expiry alarms', () => {
  const retained = snapshot(100, sevenPositions());
  const pair = fundsPair(112, {
    long: { snapshot: retained, checked_at: 100 },
  });
  pair.state.margin.checked_at = 100;
  pair.state.margin.next_check_at = 107;
  let view = accountPositionsView({ pair, side: 'long', now: 112 });
  assert.equal(view.snapshot.timestamp, 100);
  assert.equal(view.warning, false);
  assert.equal(view.label, '正在检查持仓');
  pair.state.updated_at = 150;
  pair.state.margin.status = 'cooldown';
  pair.state.margin.cooldown_until = 180;
  view = accountPositionsView({ pair, side: 'long', now: 150 });
  assert.equal(view.warning, false);
  assert.match(view.label, /冷却中/);
  assert.equal(view.snapshot.timestamp, 100);
  const stopped = accountPositionsView({ pair, side: 'long', now: 300 });
  assert.equal(stopped.warning, true);
  assert.match(stopped.notice, /长时间未更新/);
  assert.equal(stopped.snapshot.timestamp, 100);
});

test('paused retained rows remain labelled and cannot hide display or connection errors', () => {
  const retained = snapshot(100, sevenPositions());
  const pair = fundsPair(300, {
    long: { snapshot: retained, checked_at: 100 },
  });
  pair.enabled = false;
  let view = accountPositionsView({ pair, side: 'long', now: 300 });
  assert.match(view.label, /已暂停/);
  assert.equal(view.warning, false);
  assert.equal(view.snapshot.timestamp, 100);
  view = accountPositionsView({
    pair,
    side: 'long',
    now: 300,
    connectionError: '连接已断开',
  });
  assert.equal(view.warning, true);
  assert.match(view.notice, /连接异常/);
  pair.state.display_positions.long.error = '持仓清单解析失败';
  pair.state.display_positions.long.checked_at = 300;
  view = accountPositionsView({ pair, side: 'long', now: 300 });
  assert.equal(view.warning, true);
  assert.match(view.notice, /解析失败/);
});

test('a verified empty display replaces displayed holdings without changing deletion or net-quantity evidence', () => {
  const complete = {
    long: snapshot(100, [position('XAUUSD1', 'LONG', '2')]),
    short: snapshot(100, [position('XAUUSD1', 'SHORT', '1')]),
  };
  const empty = snapshot(101, []);
  const pair = fundsPair(101, { long: { snapshot: empty, checked_at: 101 } });
  pair.enabled = false;
  pair.state.snapshots = complete;
  const before = structuredClone(pair);
  const block = pairDeletionBlock(pair, 101);
  const net = pairNetQuantity(pair.state.snapshots, pair.symbol);
  const view = accountPositionsView({ pair, side: 'long', now: 101 });
  assert.equal(view.snapshot, empty);
  assert.deepEqual(view.positions, []);
  assert.match(view.emptyNotice, /清单为空/);
  assert.match(block, /仓位减回/);
  assert.equal(net, '1');
  assert.equal(pairDeletionBlock(pair, 101), block);
  assert.equal(pairNetQuantity(pair.state.snapshots, pair.symbol), net);
  assert.deepEqual(pair, before);
});

test('nullable numeric cells remain unknown and tiny or invalid quantities do not disappear', () => {
  for (const leverage of [null, undefined, '', 'invalid', '0', 0, Infinity]) {
    assert.equal(positionLeverageLabel(leverage), '—');
  }
  assert.equal(positionLeverageLabel('5'), '5x');
  assert.equal(positionLeverageLabel(20), '20x');
  for (const profit of [null, undefined, '', 'NaN'])
    assert.equal(positionProfitClass(profit), '');
  assert.equal(positionProfitClass('-1'), 'danger');
  assert.equal(positionProfitClass('0'), 'mint');
  const unknown = [null, undefined, '', '1e-999'].map((qty) =>
    position('OURAUSD1', 'LONG', qty),
  );
  const zero = ['0e999', '-0.000', '.00'].map((qty) =>
    position('OURAUSD1', 'LONG', qty),
  );
  assert.deepEqual(
    visiblePositions(snapshot(100, [...unknown, ...zero])),
    unknown,
  );
});

test('ordinary pair positions use the eight-second pair snapshot rule', () => {
  const pair = {
    ...fundsPair(1000),
    ordinary: { enabled: true },
    margin: { enabled: false, check_interval_seconds: 5 },
  };
  const account = {
    id: 'a',
    pair_id: 'pair',
    snapshot_refresh: { interval_seconds: 60 },
    snapshot: snapshot(980, [position('XAUUSD1', 'LONG', '2')]),
  };
  const view = accountPositionsView({ account, pair, side: 'long', now: 1000 });
  assert.equal(view.warning, true);
  const unpaired = { ...account, pair_id: undefined };
  assert.equal(accountPositionsView({ account: unpaired, now: 1000 }).warning, false);
});

test('a margin-only pair keeps its check interval only while nothing is pending', () => {
  const base = fundsPair(1000);
  const pair = { ...base, margin: { ...base.margin, check_interval_seconds: 60 } };
  assert.deepEqual(pairedSnapshotRefresh(undefined, pair), { interval_seconds: 60 });
  const pending = { ...pair, state: { ...pair.state, pending: { batch: {} } } };
  assert.equal(pairedSnapshotRefresh(undefined, pending), undefined);
});

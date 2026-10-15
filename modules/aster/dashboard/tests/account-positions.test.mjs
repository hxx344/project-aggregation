import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  latestPositionsSnapshot,
  strategyPositionLabel,
  visiblePositions,
} from '../lib/account-positions.ts';

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

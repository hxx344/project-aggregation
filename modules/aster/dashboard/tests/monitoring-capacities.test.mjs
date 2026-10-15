import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeMonitoredCapacityView,
  monitoredCapacityRows,
  nextMonitoredCapacitySort,
  sortMonitoredCapacityRows,
} from '../lib/monitoring-capacities.ts';

const now = 1000.25;
const symbol = { symbol: 'XAUUSD1', monitor_enabled: true };
const listing = {
  symbol: 'XAUUSD1',
  status: 'TRADING',
  capacity: '99999',
  checked_at: null,
  brackets_checked_at: 1,
  error: 'maximum tier unavailable',
  tier_capacities: { 10: '12345.67', 20: '0', 50: null },
  tier_checked_at: 999,
  tier_brackets_checked_at: 998,
  tier_error: null,
};
const listings = {
  initialized: true,
  checked_at: 997,
  stale_seconds: 180,
  rows: { XAUUSD1: listing },
};

test('fixed tiers remain valid independently of the maximum-tier sample and preserve zero/missing values', () => {
  const view = computeMonitoredCapacityView(symbol, listing, listings, now);
  assert.equal(view.status, 'active');
  assert.equal(view.dataAvailable, true);
  assert.deepEqual(view.capacities, { 10: '12345.67', 20: '0', 50: null });
  assert.equal(view.freshness.timestamp, 997);
  const noFallback = computeMonitoredCapacityView(
    symbol,
    { ...listing, tier_capacities: { 10: '', 20: '-1', 50: 'Infinity' } },
    listings,
    now,
  );
  assert.deepEqual(noFallback.capacities, { 10: null, 20: null, 50: null });
});

function capacityRows(entries) {
  return monitoredCapacityRows(
    entries.map(([symbol]) => ({ symbol, monitor_enabled: true })),
    {
      ...listings,
      rows: Object.fromEntries(
        entries.map(([symbol, value, extra = {}]) => [
          symbol,
          {
            ...listing,
            symbol,
            tier_capacities: { 10: value, 20: value, 50: value },
            ...extra,
          },
        ]),
      ),
    },
    now,
  );
}

const sortedSymbols = (rows, key, direction = 'ascending') =>
  sortMonitoredCapacityRows(rows, { key, direction }).map((row) => row.symbol);

test('each leverage sorts numerically in both directions with zero before missing and stable ties', () => {
  const rows = capacityRows([
    ['TWO', '2'],
    ['TEN', '10'],
    ['ZERO', '0'],
    ['MISSING', null],
    ['INVALID', '0x20'],
    ['ALSO_TWO', '2.00'],
    ['NEGATIVE', '-1e-999'],
  ]);
  for (const key of ['10', '20', '50']) {
    assert.deepEqual(sortedSymbols(rows, key), [
      'ZERO',
      'ALSO_TWO',
      'TWO',
      'TEN',
      'INVALID',
      'MISSING',
      'NEGATIVE',
    ]);
    assert.deepEqual(sortedSymbols(rows, key, 'descending'), [
      'TEN',
      'ALSO_TWO',
      'TWO',
      'ZERO',
      'INVALID',
      'MISSING',
      'NEGATIVE',
    ]);
  }
  const mixed = capacityRows([
    ['A', '1', { tier_capacities: { 10: '1', 20: '3', 50: '2' } }],
    ['B', '1', { tier_capacities: { 10: '2', 20: '1', 50: '3' } }],
    ['C', '1', { tier_capacities: { 10: '3', 20: '2', 50: '1' } }],
  ]);
  assert.deepEqual(sortedSymbols(mixed, '10'), ['A', 'B', 'C']);
  assert.deepEqual(sortedSymbols(mixed, '20'), ['B', 'C', 'A']);
  assert.deepEqual(sortedSymbols(mixed, '50'), ['C', 'A', 'B']);
});

test('amount sorting preserves integer, fractional and scientific-notation precision', () => {
  const rows = capacityRows([
    ['A_HIGH_INT', '9007199254740993'],
    ['B_LOW_INT', '9007199254740992'],
    ['C_HIGH_FRACTION', '1.00000000000000000002'],
    ['D_LOW_FRACTION', '1.00000000000000000001'],
    ['E_SCIENTIFIC', '1.01e-100'],
    ['F_TINY', '.0000000000000000000000001'],
    ['G_ZERO', '-0.0e2'],
    ['H_UNDERFLOW', '1e-400'],
  ]);
  const ascending = [
    'G_ZERO',
    'H_UNDERFLOW',
    'E_SCIENTIFIC',
    'F_TINY',
    'D_LOW_FRACTION',
    'C_HIGH_FRACTION',
    'B_LOW_INT',
    'A_HIGH_INT',
  ];
  assert.deepEqual(sortedSymbols(rows, '10'), ascending);
  assert.deepEqual(
    sortedSymbols(rows, '10', 'descending'),
    ascending.toReversed(),
  );
  const equal = capacityRows([
    ['C', '+0010.0'],
    ['B', '1e1'],
    ['A', '10.'],
  ]);
  for (const direction of ['ascending', 'descending'])
    assert.deepEqual(sortedSymbols(equal, '50', direction), ['A', 'B', 'C']);
});

test('symbol and sample-time sorting keep original rows and retained historical values intact', () => {
  const rows = capacityRows([
    ['A_OLD', '2', { tier_checked_at: 700, tier_brackets_checked_at: 999 }],
    [
      'B_NEW',
      '1',
      {
        tier_checked_at: 990,
        tier_brackets_checked_at: 500,
        tier_error: 'old failure',
      },
    ],
    ['C_MISSING', '0', { tier_checked_at: null }],
    ['D_UNSAMPLED', null, { tier_capacities: undefined, tier_checked_at: 999 }],
    ['E_INVALID', '0', { tier_checked_at: NaN }],
  ]);
  const before = structuredClone(rows);
  assert.deepEqual(sortedSymbols(rows, 'sampleTime'), [
    'A_OLD',
    'B_NEW',
    'C_MISSING',
    'D_UNSAMPLED',
    'E_INVALID',
  ]);
  assert.deepEqual(sortedSymbols(rows, 'sampleTime', 'descending'), [
    'B_NEW',
    'A_OLD',
    'C_MISSING',
    'D_UNSAMPLED',
    'E_INVALID',
  ]);
  assert.deepEqual(
    sortedSymbols(rows, 'symbol'),
    rows.map((row) => row.symbol),
  );
  assert.deepEqual(
    sortedSymbols(rows, 'symbol', 'descending'),
    rows.map((row) => row.symbol).toReversed(),
  );
  assert.equal(
    sortMonitoredCapacityRows(rows, { key: '10', direction: 'descending' })[0],
    rows[0],
  );
  assert.deepEqual(rows, before);
  assert.equal(rows[0].view.status, 'stale');
  assert.equal(rows[1].view.status, 'error');
  for (const timestamp of [0, -1, Infinity]) {
    const invalid = capacityRows([
      ['A', '1', { tier_checked_at: timestamp }],
      ['B', '1'],
    ]);
    for (const direction of ['ascending', 'descending'])
      assert.deepEqual(sortedSymbols(invalid, 'sampleTime', direction), [
        'B',
        'A',
      ]);
  }
});

test('column selection toggles direction and new amount or time columns start descending', () => {
  const initial = { key: 'symbol', direction: 'ascending' };
  assert.deepEqual(nextMonitoredCapacitySort(initial, 'symbol'), {
    key: 'symbol',
    direction: 'descending',
  });
  for (const key of ['10', '20', '50', 'sampleTime']) {
    const descending = nextMonitoredCapacitySort(initial, key);
    assert.deepEqual(descending, { key, direction: 'descending' });
    const ascending = nextMonitoredCapacitySort(descending, key);
    assert.deepEqual(ascending, { key, direction: 'ascending' });
    assert.deepEqual(nextMonitoredCapacitySort(ascending, key), descending);
    assert.deepEqual(nextMonitoredCapacitySort(descending, 'symbol'), initial);
  }
});

test('tier failure preserves old values and source time without inheriting maximum-tier health', () => {
  const failed = {
    ...listing,
    checked_at: now,
    brackets_checked_at: now,
    error: null,
    tier_error: 'tier fetch failed',
  };
  const view = computeMonitoredCapacityView(symbol, failed, listings, now);
  assert.equal(view.status, 'error');
  assert.equal(view.dataAvailable, false);
  assert.equal(view.hasSample, true);
  assert.deepEqual(view.capacities, listing.tier_capacities);
  assert.equal(view.freshness.timestamp, 997);
});

test('each tier source and an enabled catalog age independently using the existing expiry boundary', () => {
  for (const key of ['tier_checked_at', 'tier_brackets_checked_at']) {
    const view = computeMonitoredCapacityView(
      symbol,
      { ...listing, [key]: now - 180 },
      listings,
      now,
    );
    assert.equal(view.status, 'stale');
    assert.equal(view.dataAvailable, false);
  }
  assert.equal(
    computeMonitoredCapacityView(symbol, listing, listings, 1177).status,
    'stale',
  );
  assert.equal(
    computeMonitoredCapacityView(
      symbol,
      listing,
      { ...listings, checked_at: 1 },
      now,
    ).status,
    'stale',
  );
  assert.equal(
    computeMonitoredCapacityView(
      symbol,
      listing,
      {
        ...listings,
        checked_at: 1,
        error: 'old catalog',
        discovery_enabled: false,
      },
      now,
    ).status,
    'active',
  );
  for (const timestamp of [null, now + 2, NaN])
    assert.equal(
      computeMonitoredCapacityView(
        symbol,
        { ...listing, tier_checked_at: timestamp },
        listings,
        now,
      ).status,
      'stale',
    );
});

test('first sample, missing tiers, pause, delisting, catalog failure and connection loss stay distinct', () => {
  const unsampled = {
    symbol: 'XAUUSD1',
    status: 'TRADING',
    capacity: '777',
    checked_at: now,
  };
  assert.equal(
    computeMonitoredCapacityView(symbol, unsampled, listings, now).status,
    'waiting',
  );
  assert.equal(
    computeMonitoredCapacityView(symbol, undefined, listings, now).status,
    'waiting',
  );
  assert.equal(
    computeMonitoredCapacityView(
      symbol,
      { ...unsampled, tier_error: 'offline' },
      listings,
      now,
    ).status,
    'error',
  );
  assert.equal(
    computeMonitoredCapacityView(
      symbol,
      { ...listing, tier_capacities: { 10: null, 20: null, 50: null } },
      listings,
      now,
    ).status,
    'active',
  );
  for (const options of [{ monitoringEnabled: false }, { demo: true }]) {
    const view = computeMonitoredCapacityView(
      symbol,
      listing,
      listings,
      now,
      options,
    );
    assert.equal(view.status, 'paused');
    assert.equal(view.dataAvailable, false);
  }
  assert.equal(
    computeMonitoredCapacityView(
      symbol,
      { ...listing, status: 'CLOSE' },
      listings,
      now,
    ).status,
    'unavailable',
  );
  assert.equal(
    computeMonitoredCapacityView(
      symbol,
      listing,
      { ...listings, error: 'catalog failed' },
      now,
    ).status,
    'error',
  );
  assert.equal(
    computeMonitoredCapacityView(symbol, listing, listings, now, {
      connectionError: true,
    }).status,
    'stale',
  );
  assert.equal(
    computeMonitoredCapacityView(symbol, unsampled, listings, now, {
      connectionError: true,
    }).status,
    'stale',
  );
});

test('rows follow each saved monitor switch while a global pause keeps all selected symbols visible', () => {
  const symbols = [
    symbol,
    { symbol: 'BTCUSD1', monitor_enabled: false },
    { symbol: 'SOLUSD1', monitor_enabled: true },
  ];
  const rows = monitoredCapacityRows(symbols, listings, now, {
    monitoringEnabled: false,
  });
  assert.deepEqual(
    rows.map((row) => row.symbol),
    ['SOLUSD1', 'XAUUSD1'],
  );
  assert.equal(
    rows.every((row) => row.view.status === 'paused'),
    true,
  );
  assert.deepEqual(
    monitoredCapacityRows(
      symbols.map((row) => ({ ...row, monitor_enabled: false })),
      listings,
      now,
    ),
    [],
  );
});

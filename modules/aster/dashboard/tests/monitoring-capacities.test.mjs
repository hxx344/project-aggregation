import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeMonitoredCapacityView,
  monitoredCapacityRows,
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

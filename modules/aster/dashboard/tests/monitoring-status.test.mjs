import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeFreshness,
  computeSymbolView,
} from '../lib/monitoring-status.ts';

const now = 1000.25;
const symbol = { monitor_enabled: true };
const row = { status: 'TRADING', checked_at: 999, brackets_checked_at: 998 };
const catalog = { initialized: true, checked_at: 997, stale_seconds: 180 };

test('freshness uses fractional seconds and precise aging/expiry boundaries', () => {
  for (const [age, expected] of [
    [89.99, 'fresh'],
    [90, 'aging'],
    [179.99, 'aging'],
    [180, 'stale'],
  ]) {
    assert.equal(computeFreshness(now - age, now).status, expected);
  }
  for (const stamp of [
    null,
    undefined,
    true,
    '999',
    0,
    -1,
    NaN,
    Infinity,
    now + 1.01,
  ]) {
    assert.equal(computeFreshness(stamp, now).status, 'stale');
  }
  assert.equal(computeFreshness(now + 1, now).ageSeconds, 0);
  assert.equal(computeFreshness(999, NaN).status, 'stale');
});

test('catalog, brackets and capacity all age independently without another server response', () => {
  assert.equal(computeSymbolView(symbol, row, catalog, now).status, 'active');
  assert.equal(
    computeSymbolView(symbol, row, catalog, now).freshness.timestamp,
    997,
  );
  assert.equal(computeSymbolView(symbol, row, catalog, 1177).status, 'stale');
  for (const key of ['checked_at', 'brackets_checked_at']) {
    const view = computeSymbolView(
      symbol,
      { ...row, [key]: now - 180 },
      catalog,
      now,
    );
    assert.equal(view.status, 'stale');
    assert.equal(view.dataAvailable, false);
  }
  assert.equal(
    computeSymbolView(symbol, row, { ...catalog, checked_at: 1 }, now).status,
    'stale',
  );
  assert.equal(
    computeSymbolView(
      symbol,
      row,
      { ...catalog, checked_at: 1, error: 'offline', discovery_enabled: false },
      now,
    ).status,
    'active',
  );
  assert.equal(
    computeSymbolView(
      symbol,
      { ...row, brackets_checked_at: null },
      catalog,
      now,
    ).status,
    'stale',
  );
  assert.equal(
    computeSymbolView(symbol, undefined, catalog, now).status,
    'stale',
  );
});

test('five-state precedence preserves errors, delisting, paused sampling and connection loss', () => {
  const broken = { ...row, error: 'failed', status: 'CLOSE', checked_at: 1 };
  assert.equal(computeSymbolView(symbol, broken, catalog, now).status, 'error');
  for (const options of [{ monitoringEnabled: false }, { demo: true }]) {
    assert.equal(
      computeSymbolView(symbol, broken, catalog, now, options).status,
      'paused',
    );
  }
  assert.equal(
    computeSymbolView({ monitor_enabled: false }, broken, catalog, now).status,
    'paused',
  );
  assert.equal(
    computeSymbolView(symbol, { ...broken, error: null }, catalog, now).status,
    'unavailable',
  );
  assert.equal(
    computeSymbolView(symbol, row, catalog, now, { connectionError: true })
      .status,
    'stale',
  );
});

test('only an explicit monitor_enabled flag can activate monitoring', () => {
  for (const control of [
    {},
    { monitor: true },
    { monitor: false },
    { monitor_enabled: undefined, monitor: true },
    { monitor_enabled: null },
    { monitor_enabled: 'true' },
  ]) {
    const view = computeSymbolView(control, row, catalog, now);
    assert.equal(view.status, 'paused');
    assert.equal(view.dataAvailable, false);
  }
  assert.equal(
    computeSymbolView(
      { monitor_enabled: true, monitor: false },
      row,
      catalog,
      now,
    ).status,
    'active',
  );
});

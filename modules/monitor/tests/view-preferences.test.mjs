import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPreference, rangePreference, legPreference, basisPreference, booleanPreference, readViewPreference, writeViewPreference } from '../lib/view-preferences.ts';

test('only supported chart choices and boolean indicators restore', () => {
  assert.deepEqual(chartPreference({ mode: 'price', sma: false, bands: false, zscore: true, quotes: [1] }), { mode: 'price', sma: false, bands: false, zscore: true });
  assert.deepEqual(chartPreference({ mode: 'unknown', sma: 'false' }), { mode: null, sma: true, bands: true, zscore: true });
  assert.equal(rangePreference(null, 7), null); assert.equal(rangePreference(30, 7), 30); assert.equal(rangePreference(365, 7), 7);
  assert.equal(legPreference('rh'), 'rh'); assert.equal(legPreference('unknown'), 'xyz');
  assert.equal(basisPreference('notional'), 'notional'); assert.equal(basisPreference(false), 'quantity');
  assert.equal(booleanPreference('false', true), true);
});

test('storage retains explicit null in an envelope and fails without interrupting the view', () => {
  const memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) } });
  writeViewPreference('range', { value: null }); assert.deepEqual(readViewPreference('range'), { value: null });
  memory.set('range', '{'); assert.equal(readViewPreference('range'), null);
  memory.set('range', 'x'.repeat(4097)); assert.equal(readViewPreference('range'), null);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('blocked'); } });
  assert.equal(readViewPreference('range'), null); assert.doesNotThrow(() => writeViewPreference('range', true));
  delete globalThis.localStorage;
});

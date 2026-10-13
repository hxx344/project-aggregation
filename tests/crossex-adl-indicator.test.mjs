import test from 'node:test';
import assert from 'node:assert/strict';
import { adlRedLights } from '../modules/crossex/src/adl-indicator.ts';

test('CrossEx and Binance ranks increase red lights toward the front of their queues', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(rank => adlRedLights(String(rank), 'crossex')), [1, 2, 3, 4, 5]);
  assert.deepEqual([0, 1, 2, 3, 4].map(rank => adlRedLights(rank, 'exchange', 'BINANCE')), [1, 2, 3, 4, 5]);
});

test('Gate and Kraken invert their native ranking so more red always means higher priority', () => {
  assert.deepEqual([5, 4, 3, 2, 1].map(rank => adlRedLights(rank, 'exchange', 'gate')), [1, 2, 3, 4, 5]);
  assert.deepEqual([100, 80, 60, 40, 20].map(rank => adlRedLights(rank, 'exchange', 'kraken')), [1, 2, 3, 4, 5]);
  assert.equal(adlRedLights(3, 'exchange', 'gate'), adlRedLights(60, 'exchange', 'kraken'));
});

test('OKX and Bybit retain their explicit lowest zero level as five green lights', () => {
  for (const exchange of ['okx', 'bybit']) {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(rank => adlRedLights(rank, 'exchange', exchange)), [0, 1, 2, 3, 4, 5]);
  }
});

test('missing, malformed and out-of-range values never become a low-priority indication', () => {
  for (const value of [null, undefined, '', ' ', 'NaN', NaN, Infinity, -1, 1.5, '1.5', '1e0', {}, false]) {
    assert.equal(adlRedLights(value, 'crossex'), null);
    assert.equal(adlRedLights(value, 'exchange', 'bybit'), null);
  }
  for (const [exchange, invalid] of [['binance', 5], ['gate', 0], ['kraken', 3], ['kraken', 0], ['okx', 6], ['bybit', 6]]) {
    assert.equal(adlRedLights(invalid, 'exchange', exchange), null);
  }
  assert.equal(adlRedLights(0, 'crossex'), null);
  assert.equal(adlRedLights(6, 'crossex'), null);
});

test('unverified exchange scales stay unknown instead of borrowing another exchange scale', () => {
  for (const exchange of ['hyperliquid', 'deribit', 'lighter', 'unknown', '', '__proto__', 'constructor']) {
    assert.equal(adlRedLights(1, 'exchange', exchange), null);
    assert.equal(adlRedLights(5, 'exchange', exchange), null);
  }
  assert.equal(adlRedLights(' 4 ', 'exchange', ' Binance '), 5);
});

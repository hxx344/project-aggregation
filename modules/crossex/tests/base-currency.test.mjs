import test from 'node:test';
import assert from 'node:assert/strict';
import { availableBase, matchingBases } from '../src/base-currency.ts';

test('base search ignores case and surrounding whitespace, prioritizing exact and prefix matches', () => {
  const bases = ['1000BTC', 'BLEND', 'BTC', 'BTCUSDT', 'ETH'];
  assert.deepEqual(matchingBases(bases, ' btC '), ['BTC', 'BTCUSDT', '1000BTC']);
  assert.deepEqual(matchingBases(bases, 'lend'), ['BLEND']);
  assert.deepEqual(matchingBases(bases, 'unknown'), []);
  assert.deepEqual(matchingBases(bases, ''), bases);
  assert.deepEqual(bases, ['1000BTC', 'BLEND', 'BTC', 'BTCUSDT', 'ETH']);
});

test('removed and blank base selections recover to BTC or the first available currency', () => {
  assert.equal(availableBase('BLEND', ['BTC', 'ETH']), 'BTC');
  assert.equal(availableBase('', ['BTC', 'ETH']), 'BTC');
  assert.equal(availableBase('BLEND', ['ETH', 'SOL']), 'ETH');
  assert.equal(availableBase('ETH', ['BTC', 'ETH']), 'ETH');
  assert.equal(availableBase('BTC', []), '');
});

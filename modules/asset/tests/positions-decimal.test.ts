import test from 'node:test';
import assert from 'node:assert/strict';
import { decimal, POSITIONS_INVALID } from '../lib/positions-decimal.ts';
import { decimal as serverDecimal } from '../lib/positions-values.ts';
import { add, compare, divide, multiply } from '../lib/positions-cycle.ts';

test('pure decimal validation retains the original grammar, 128-character boundary and error semantics', () => {
  assert.equal(serverDecimal, decimal);
  for (const value of ['0', '-0', '0001.2300', '-0.000000000000000001', '1'.repeat(128)]) assert.equal(decimal(value), value);
  for (const value of [0, null, undefined, ['1'], '1'.repeat(129), '1e3', '+1', ' 1', '1 ', '.1', '1.']) {
    assert.throws(() => decimal(value), { message: POSITIONS_INVALID });
  }
  assert.equal(add('0.1', '0.2'), '0.3');
  assert.equal(multiply('100', '1.1'), '110');
  assert.equal(compare('0.000000000000000001', '0'), 1);
  assert.equal(divide('1', '3'), '0.333333333333');
  assert.throws(() => divide('1', '0'), { message: POSITIONS_INVALID });
});

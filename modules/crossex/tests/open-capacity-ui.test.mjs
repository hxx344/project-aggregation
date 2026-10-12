import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCapacity, capacityIsFresh } from '../src/open-capacity.ts';

const symbol = 'BINANCE_FUTURE_SOL_USDT';
const input = { order: { symbol, side: 'BUY', orderType: 'MARKET', timeInForce: 'IOC' } };
const snapshot = () => ({
  status: 'ready', reason: null, asOf: 10000, expiresAt: 20000, connectionVersion: 2, base: 'SOL',
  maxQuantity: '123.456789123456789', maxNotionalUSDT: '12345.6789123456789', requiredMargin: null,
  marginCurrency: 'USDT', reserveFactor: '1.10', inputWithinCapacity: null, limitingFactors: ['单腿名义额上限'], notes: [],
  legs: [{ symbol, side: 'BUY', quoteCurrency: 'USDT', leverage: '5', maxLeverage: null,
    maxQuantity: '123.456789123456789', maxNotionalUSDT: '12345.6789123456789', notionalUSDT: null, requiredMargin: null, availableMargin: '3000' }],
});

test('capacity responses remain bound to the selected account, symbol and direction', () => {
  assert.equal(parseOpenCapacity(snapshot(), input, 2).maxQuantity, '123.456789123456789');
  assert.throws(() => parseOpenCapacity(snapshot(), input, 3));
  assert.throws(() => parseOpenCapacity(snapshot(), { order: { ...input.order, symbol: 'GATE_FUTURE_SOL_USDT' } }, 2));
  assert.throws(() => parseOpenCapacity(snapshot(), { order: { ...input.order, side: 'SELL' } }, 2));
  assert.throws(() => parseOpenCapacity(snapshot(), { pair: { longSymbol: symbol, shortSymbol: 'GATE_FUTURE_SOL_USDT' } }, 2));
});

test('missing estimates stay unknown and blocked responses cannot advertise positive capacity', () => {
  const unavailable = { ...snapshot(), status: 'unavailable', reason: '账户数据待更新', maxQuantity: null, maxNotionalUSDT: null, legs: [] };
  assert.equal(parseOpenCapacity(unavailable, input, 2).maxQuantity, null);
  const blocked = { ...unavailable, status: 'blocked', maxQuantity: '0', maxNotionalUSDT: '0' };
  assert.equal(parseOpenCapacity(blocked, input, 2).maxQuantity, '0');
  assert.throws(() => parseOpenCapacity({ ...blocked, maxQuantity: '1' }, input, 2));
  assert.throws(() => parseOpenCapacity({ ...snapshot(), maxQuantity: null }, input, 2));
  const missingLeverage = snapshot(); missingLeverage.legs[0].leverage = null;
  assert.throws(() => parseOpenCapacity(missingLeverage, input, 2));
});

test('non-finite, negative and malformed limit data cannot be shown as an actionable estimate', () => {
  for (const value of ['NaN', 'Infinity', '-1', '', 42, undefined]) {
    assert.throws(() => parseOpenCapacity({ ...snapshot(), maxQuantity: value }, input, 2));
  }
  for (const leverage of ['0', '-1', 'Infinity']) {
    const result = snapshot(); result.legs[0].leverage = leverage;
    assert.throws(() => parseOpenCapacity(result, input, 2));
  }
  assert.throws(() => parseOpenCapacity({ ...snapshot(), expiresAt: 9000 }, input, 2));
  assert.throws(() => parseOpenCapacity({ ...snapshot(), legs: [null] }, input, 2));
  const negativeBalance = { ...snapshot(), status: 'blocked', maxQuantity: '0', maxNotionalUSDT: '0', reason: '账户可用保证金不足' };
  negativeBalance.legs[0].availableMargin = '-15.5';
  assert.equal(parseOpenCapacity(negativeBalance, input, 2).legs[0].availableMargin, '-15.5');
});

test('capacity expires against server time without extending the source timestamp', () => {
  const result = snapshot();
  assert.equal(capacityIsFresh(result, 19999), true);
  assert.equal(capacityIsFresh(result, 20000), false);
  assert.equal(capacityIsFresh(result, 8000), false);
  assert.equal(capacityIsFresh(result, NaN), false);
});

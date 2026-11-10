import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecimalError, add, cmp, decimal, floorToStep, fromUnits, isMultiple, mul, sub, units } from '../src/decimal.ts';
import { parseOrderReport } from '../src/connector.ts';
import { ContractError, parseQuote, checkQuoteFresh } from '../src/contracts.ts';

test('十进制：规范化、精确加减乘与步长取整', () => {
  assert.equal(decimal('0010.5000'), '10.5');
  assert.equal(decimal('-0.0'), '0');
  assert.equal(add('0.1', '0.2'), '0.3');
  assert.equal(sub('1', '0.000000000000000001'), '0.999999999999999999');
  assert.equal(mul('0.333333333333333333', '3'), '0.999999999999999999');
  assert.equal(floorToStep('0.459', '0.1'), '0.4');
  assert.equal(isMultiple('1.20', '0.1'), true);
  assert.equal(isMultiple('1.25', '0.1'), false);
  assert.equal(cmp('2', '10'), -1);
  assert.equal(fromUnits(units('123456789.123456789')), '123456789.123456789');
  for (const bad of ['1e3', '0.1234567890123456789', '', ' 1', 'NaN', '1.']) assert.throws(() => units(bad), DecimalError);
  assert.throws(() => decimal(1 as unknown as string), DecimalError);
  assert.throws(() => decimal('0', 'positive'), DecimalError);
});

const request = { clientOrderId: 'pa1-x-0', symbol: 'CLUSDT', side: 'buy' as const, quantity: '1' };
const report = { clientOrderId: 'pa1-x-0', remoteId: 'r1', symbol: 'CLUSDT', side: 'buy', quantity: '1', filledQuantity: '1', averagePrice: '70', status: 'filled', terminal: true, updatedAt: 1 };
const contractCode = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;

test('委托回报：身份、超额成交、终态与均价不一致都不能结算操作', () => {
  assert.equal(parseOrderReport(report, request).status, 'filled');
  assert.throws(() => parseOrderReport({ ...report, clientOrderId: 'pa1-y-0' }, request), contractCode('report_identity'));
  assert.throws(() => parseOrderReport({ ...report, quantity: '2' }, request), contractCode('report_identity'));
  assert.throws(() => parseOrderReport({ ...report, filledQuantity: '1.5' }, request), contractCode('report_overfill'));
  assert.throws(() => parseOrderReport({ ...report, terminal: false }, request), contractCode('report_terminal'));
  assert.throws(() => parseOrderReport({ ...report, averagePrice: null }, request), contractCode('report_price'));
  assert.throws(() => parseOrderReport({ ...report, extra: 1 }, request), contractCode('unknown_field'));
});

test('盘口：交叉盘口拒绝；新鲜度按原始接收时间判断，超前时间与过期都拒绝', () => {
  const raw = { venue: 'binance', symbol: 'CLUSDT', bid: '70', ask: '70.02', sourceTime: null, receivedAt: 1_000, connectionGeneration: 1, sequence: 5, complete: true };
  assert.throws(() => parseQuote({ ...raw, bid: '70.02' }, 'binance', 'CLUSDT'), contractCode('quote_crossed'));
  assert.throws(() => parseQuote(raw, 'bybit', 'CLUSDT'), contractCode('quote_identity'));
  const quote = parseQuote(raw, 'binance', 'CLUSDT');
  checkQuoteFresh(quote, 11_000, 10_000, 1_000);
  assert.throws(() => checkQuoteFresh(quote, 11_001, 10_000, 1_000), contractCode('quote_stale'));
  assert.throws(() => checkQuoteFresh(quote, -1, 10_000, 1_000), contractCode('quote_future'));
});

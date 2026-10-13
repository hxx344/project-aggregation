import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAccountHistory, historyTime } from '../modules/crossex/src/account-history.ts';

const fill = (patch = {}) => ({ user_id: 'u1', exchange_type: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', order_id: '90071992547409930',
  transaction_id: 'fill1', side: 'BUY', qty: '0.1', price: '100', fee: '-0.01', fee_coin: 'USDT', rpnl: '0', create_time: '1700000000000', ...patch });
const entry = (patch = {}) => ({ user_id: 'u1', exchange_type: 'CROSSEX', symbol: 'GATE_FUTURE_BTC_USDT', business_id: '90071992547409930',
  id: 'book1', statement_type: 'TRADING_FEE', change: '-0.01', coin: 'USDT', create_time: '1700000000000', ...patch });

test('partial fills aggregate by exact order ID with quantity-weighted price and signed decimal sums', () => {
  const rows = [fill(), fill({ transaction_id: 'fill2', qty: '0.3', price: '200', fee: '0.002', rpnl: '1.000000000000000001', create_time: '1700000001000' })];
  const original = structuredClone(rows), groups = groupAccountHistory(rows, 'trades');
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.orderId, '90071992547409930'); assert.equal(group.quantity, '0.4'); assert.equal(group.price, '175');
  assert.deepEqual(group.fees, [{ currency: 'USDT', value: '-0.008' }]); assert.equal(group.realizedPnl, '1.000000000000000001');
  assert.equal(group.firstAt, 1700000000000); assert.equal(group.lastAt, 1700000001000);
  assert.deepEqual(group.rows.map(row => row.transaction_id), ['fill2', 'fill1']); assert.deepEqual(rows, original);
});

test('different orders, users, venues, symbols and directions never share a summary', () => {
  const variants = [{}, { order_id: '90071992547409931' }, { user_id: 'u2' }, { exchange_type: 'BYBIT' },
    { symbol: 'GATE_FUTURE_ETH_USDT' }, { side: 'SELL' }, { position_side: 'SHORT' }];
  assert.equal(groupAccountHistory(variants.map(fill), 'trades').length, variants.length);
  assert.equal(groupAccountHistory([fill({ order_id: '' }), fill({ order_id: '' })], 'trades').length, 2);
  assert.equal(groupAccountHistory([fill({ symbol: '' }), fill({ symbol: '' })], 'trades').length, 2);
});

test('fees retain separate currencies and missing amounts are unknown rather than zero', () => {
  const group = groupAccountHistory([fill(), fill({ fee_coin: 'BNB', fee: '0.000000000000000001', qty: null, price: null, rpnl: null })], 'trades')[0];
  assert.deepEqual(group.fees, [{ currency: 'USDT', value: '-0.01' }, { currency: 'BNB', value: '0.000000000000000001' }]);
  assert.equal(group.quantity, null); assert.equal(group.price, null); assert.equal(group.realizedPnl, null);
  assert.deepEqual(groupAccountHistory([fill(), fill({ fee: undefined })], 'trades')[0].fees, [{ currency: 'USDT', value: null }]);
  assert.deepEqual(groupAccountHistory([fill({ fee_coin: '' })], 'trades')[0].fees, [{ currency: '币种未知', value: '-0.01' }]);
});

test('book merges trade changes and fees for one order, keeping signed type and currency totals', () => {
  const rows = [entry(), entry({ id: 'book2', change: '-0.02' }), entry({ id: 'book3', statement_type: 'TRANSACTION', change: '2' }),
    entry({ id: 'book4', coin: 'BTC', change: '-0.000001' })];
  const groups = groupAccountHistory(rows, 'book'); assert.equal(groups.length, 1); assert.equal(groups[0].rows.length, 4);
  assert.deepEqual(groups[0].changes, [{ currency: 'USDT', value: '1.97' }, { currency: 'BTC', value: '-0.000001' }]);
  assert.deepEqual(groups[0].statements, [
    { type: 'TRADING_FEE', amounts: [{ currency: 'USDT', value: '-0.03' }, { currency: 'BTC', value: '-0.000001' }] },
    { type: 'TRANSACTION', amounts: [{ currency: 'USDT', value: '2' }] },
  ]);
});

test('funding, transfers and missing business IDs never inherit an order from matching IDs or times', () => {
  const rows = [entry(), ...['FUNDING_FEE', 'FUNDING_FEE', 'TRANSFER_IN', 'TRANSFER_OUT', 'OTHER'].map(statement_type => entry({ statement_type })),
    entry({ business_id: '' }), entry({ business_id: '' })];
  const groups = groupAccountHistory(rows, 'book'); assert.equal(groups.length, rows.length);
  assert.equal(groups.filter(group => group.orderId).length, 1);
});

test('book separates account and contract identity even when business IDs collide', () => {
  const variants = [{}, { user_id: 'u2' }, { exchange_type: 'GATE' }, { symbol: 'BYBIT_FUTURE_BTC_USDT' }, { business_id: 'next' }];
  assert.equal(groupAccountHistory(variants.map(entry), 'book').length, variants.length);
  assert.equal(groupAccountHistory([entry(), entry({ change: null })], 'book')[0].changes[0].value, null);
});

test('aggregation uses every loaded fill before the UI group limit and sorts newest groups first', () => {
  const rows = Array.from({ length: 200 }, (_, index) => fill({ transaction_id: String(index), qty: '0.01' }));
  rows.push(fill({ order_id: 'newer', create_time: '1700000002000' }));
  const groups = groupAccountHistory(rows, 'trades');
  assert.equal(groups.length, 2); assert.equal(groups[0].orderId, 'newer'); assert.equal(groups[1].quantity, '2'); assert.equal(groups[1].rows.length, 200);
});

test('invalid numeric values stay unknown and timestamps accept seconds or milliseconds', () => {
  for (const value of ['', 'NaN', 'Infinity', 'oops']) {
    const group = groupAccountHistory([fill({ qty: value, price: value, fee: value, rpnl: value })], 'trades')[0];
    assert.equal(group.quantity, null); assert.equal(group.price, null); assert.equal(group.fees[0].value, null); assert.equal(group.realizedPnl, null);
  }
  assert.equal(historyTime({ create_time: '1700000000' }), 1700000000000);
  assert.equal(historyTime({ create_time: '1700000000000' }), 1700000000000);
  assert.equal(historyTime({ create_time: 'invalid' }), null);
});

test('independent settlement keys survive polling inserts and record reordering', () => {
  const older = entry({ id: 'funding-old', statement_type: 'FUNDING_FEE' });
  const newer = entry({ id: 'funding-new', statement_type: 'FUNDING_FEE', create_time: '1700000002000' });
  const before = groupAccountHistory([older], 'book')[0].key;
  const after = groupAccountHistory([newer, older], 'book');
  assert.equal(after.find(group => group.rows[0].id === 'funding-old').key, before);
  assert.notEqual(after[0].key, before);
});

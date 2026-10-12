import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { exact, formatDecimal, formatSigned, signedAmount, netBaseQuantity, positiveQuantity, stateIsUncertain, sideLabel, liquidationPrice } from '../src/live-display.ts';
import { readPendingRequest, writePendingRequest, requestStorageKey, readRequestStatus, resolveRequestStatus } from '../src/live-requests.ts';
const sourceResolution = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(context.parentURL?.endsWith('/src/position-view.ts') && specifier === './live-display' ? './live-display.ts' : specifier, context);
} });
const { fractionQuantity, groupPositions, instrumentFees, sumNative, weightedPrice, percentage } = await import('../src/position-view.ts');
sourceResolution.deregister();

test('exchange decimal amounts retain digits beyond JavaScript numeric precision', () => {
  assert.equal(exact('9007199254740993.1234567890123456789'), '9007199254740993.1234567890123456789');
  assert.equal(signedAmount('0.0000000000000000001'), '+0.0000000000000000001');
  assert.equal(exact(null), '—');
  assert.equal(exact(''), '—');
  assert.equal(exact('not-a-number'), '—');
});

test('compact decimal display removes binary tails without changing original amounts', () => {
  const quantity = '0.0075000000000000001', cumulative = '1.2501000000000004';
  assert.equal(formatDecimal(quantity), '0.0075');
  assert.equal(formatDecimal(cumulative), '1.2501');
  assert.equal(formatDecimal('80688.00000000001', 'price'), '80688');
  assert.equal(formatDecimal('80688.125', 'price'), '80688.125');
  assert.equal(formatDecimal('9876.5432198765', 'amount'), '9876.5432');
  assert.equal(exact(quantity), quantity);
  assert.equal(exact(cumulative), cumulative);
});

test('tiny prices, fees and signed residuals remain nonzero and bounded', () => {
  assert.equal(formatDecimal('0.00000001', 'price'), '0.00000001');
  assert.equal(formatDecimal('0.000000000123456789', 'price'), '1.235e-10');
  assert.equal(formatDecimal('0.000012345678', 'amount'), '0.00001235');
  assert.equal(formatSigned('-0.0000000000000000001', 'amount'), '-1e-19');
  assert.equal(formatSigned('0.0000000000000000001'), '+1e-19');
  assert.equal(formatDecimal('9007199254740993.1234567890123456789'), '9.0072e+15');
  for (const value of ['-0', '-0.000', '0', '0.000']) {
    assert.equal(formatDecimal(value), '0'); assert.equal(formatSigned(value), '0');
  }
  for (const value of [null, undefined, '', ' ', 'NaN', 'Infinity', 'not-a-number']) assert.equal(formatDecimal(value), '—');
});

test('display bounds handle scientific notation without rounding rates to zero', () => {
  for (const kind of ['price', 'quantity', 'amount', 'rate']) for (const value of ['1e-100', '-1e100', '0.0000001234567890123', '9999999999.999999999999']) {
    const text = formatDecimal(value, kind);
    assert.notEqual(text, '0'); assert.ok(text.length <= 16, `${kind}: ${text}`);
  }
  assert.equal(percentage('0.0000000591'), '0.00000591%');
  assert.equal(percentage('-0.00001'), '-0.001%');
  assert.equal(percentage('0.0123456789'), '1.2346%');
  assert.equal(percentage(null), '—');
  assert.equal(percentage('-0'), '0%');
});

test('net exposure uses native LONG/SHORT and preserves exact residuals', () => {
  assert.equal(netBaseQuantity([{ side: 'LONG', baseQuantity: '9007199254740993.1234567890123456789' }, { side: 'SHORT', baseQuantity: '9007199254740993.1234567890123456788' }]), '0.0000000000000000001');
  assert.equal(netBaseQuantity([{ side: 'long', baseQuantity: '0.1' }, { side: 'short', baseQuantity: '0.3' }]), '-0.2');
  assert.equal(netBaseQuantity([{ side: 'LONG', baseQuantity: '1' }, { side: 'SHORT', baseQuantity: null }]), null);
  assert.equal(netBaseQuantity([{ side: 'UNKNOWN', baseQuantity: '1' }]), null);
});

test('only positive plain decimal quantities can reach a partial-close preview', () => {
  assert.equal(positiveQuantity('0.00000001'), true);
  for (const value of ['0', '-1', '', 'Infinity', 'NaN', '1e4', '1,000']) assert.equal(positiveQuantity(value), false);
});

test('known accepted orders allow manual management while unknown writes stay locked', () => {
  for (const state of ['UNKNOWN', 'CANCEL_PENDING', 'RECONCILING', 'SENDING', 'INVALID']) assert.equal(stateIsUncertain(state), true);
  for (const state of ['pending', 'completed', 'partial', 'failed', 'NEW', 'OPEN']) assert.equal(stateIsUncertain(state), false);
  assert.equal(sideLabel('BUY'), '买入');
  assert.equal(sideLabel('NONE'), '单向持仓');
});

test('zero and unavailable liquidation prices are not presented as actionable prices', () => {
  for (const value of ['0', '0.000', '-1', '', null, undefined, 'Infinity', 'invalid']) assert.equal(liquidationPrice(value), null);
  assert.equal(liquidationPrice('0.000000001'), '0.000000001');
  assert.equal(liquidationPrice('50000.125'), '50000.125');
});

const pending = { version: 1, id: 'request-0123456789', kind: 'confirm' };
const memoryStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

test('pending identity survives reload without retaining credentials or order parameters', () => {
  const storage = memoryStorage(), key = requestStorageKey('/cross-ex/');
  assert.equal(writePendingRequest(storage, key, { ...pending, apiSecret: 'must-not-store', quantity: '100' }), true);
  assert.deepEqual(readPendingRequest(storage, key), pending);
  assert.equal(storage.getItem(key).includes('must-not-store'), false);
  assert.equal(storage.getItem(key).includes('quantity'), false);
  assert.equal(readPendingRequest(storage, requestStorageKey('/another-module/')), null);
  assert.equal(writePendingRequest(storage, key, null), true);
  assert.equal(readPendingRequest(storage, key), null);
});

test('unavailable session storage blocks initial persistence without throwing', () => {
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(readPendingRequest(storage, 'key'), null);
  assert.equal(writePendingRequest(storage, 'key', pending), false);
  assert.equal(writePendingRequest(null, 'key', pending), false);
  const malformed = memoryStorage(); malformed.setItem('key', '{broken');
  assert.equal(readPendingRequest(malformed, 'key'), null);
});

test('lost confirmation can recover through a read-only not-submitted status without replay', async () => {
  const storage = memoryStorage(), key = requestStorageKey('/'), calls = [];
  writePendingRequest(storage, key, pending);
  const restored = readPendingRequest(storage, key);
  const status = await readRequestStatus(restored, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ requestStatus: 'not_submitted' }), { status: 200 });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/live/requests/' + pending.id);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(resolveRequestStatus(restored, status), { resolved: true, notSubmitted: true });
  assert.deepEqual(readPendingRequest(storage, key), pending, 'query never clears the marker without the caller accepting a verified outcome');
});

test('submitted results unlock only the matching request with known order states', () => {
  const envelope = result => ({ requestStatus: 'submitted', kind: 'confirm', result: { requestId: pending.id, ...result } });
  assert.equal(resolveRequestStatus(pending, envelope({ state: 'reconciling', legs: [{ status: 'UNKNOWN' }] })).resolved, false);
  assert.equal(resolveRequestStatus(pending, envelope({ state: 'pending', legs: [{ status: 'NEW' }] })).resolved, true);
  assert.equal(resolveRequestStatus(pending, envelope({ state: 'completed', legs: [{ status: 'FILLED' }] })).resolved, true);
  assert.equal(resolveRequestStatus(pending, envelope({ state: 'partial', legs: [{ status: 'FILLED' }, { status: 'UNSENT' }] })).resolved, true);
  assert.equal(resolveRequestStatus(pending, envelope({ requestId: 'different-id', state: 'completed', legs: [{ status: 'FILLED' }] })).resolved, false);
  assert.equal(resolveRequestStatus(pending, envelope({ state: 'pending', legs: [{ status: 'UNRECOGNIZED' }] })).resolved, false);
  for (const invalid of [{}, null, { requestStatus: 'unknown' }, { requestStatus: 'submitted', kind: 'cancel', result: {} }]) assert.equal(resolveRequestStatus(pending, invalid).resolved, false);
});

test('cancel recovery retains the tracked order identity until a real terminal outcome', () => {
  const cancel = { ...pending, kind: 'cancel', orderId: 'exchange-order' };
  const response = status => ({ requestStatus: 'submitted', kind: 'cancel', result: { requestId: cancel.id, orderId: 'tracked-order', order: { id: 'tracked-order', status } } });
  assert.deepEqual(resolveRequestStatus(cancel, response('CANCEL_PENDING')), { resolved: false, notSubmitted: false, orderId: 'tracked-order' });
  assert.equal(resolveRequestStatus(cancel, response('OPEN')).resolved, false);
  assert.equal(resolveRequestStatus(cancel, response('CANCELLED')).resolved, true);
  assert.equal(resolveRequestStatus(cancel, response('FILLED')).resolved, true);
});

test('failed status reads cannot treat missing or unreachable service responses as no submission', async () => {
  await assert.rejects(readRequestStatus(pending, async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(readRequestStatus(pending, async () => new Response(JSON.stringify({ requestStatus: 'not_submitted', error: 'not authoritative' }), { status: 503 })), /not authoritative/);
});

test('percentage closes floor to base quantity step without floating-point loss', () => {
  assert.equal(fractionQuantity('0.1234567890123456789', 25, '0.0000000000000000001'), '0.0308641972530864197');
  assert.equal(fractionQuantity('0.015', 50, '0.01'), null);
  assert.equal(fractionQuantity('1.9', 75, '0.1'), '1.4');
  assert.equal(fractionQuantity('0.1234567890123456789', 100), '0.1234567890123456789');
  assert.equal(fractionQuantity('1', 50), null);
  assert.equal(fractionQuantity(null, 100), null);
  assert.equal(fractionQuantity('1', 0, '0.1'), null);
});

const position = (changes = {}) => ({ id: 'a', symbol: 'BINANCE_PERP_BTC_USDT', exchange: 'binance', baseCurrency: 'BTC', quoteCurrency: 'USDT', side: 'LONG', baseQuantity: '0.1', entryPrice: '100', markPrice: '101', notional: '10.1', unrealizedPnl: '0.1', pnlCurrency: 'USDT', ...changes });

test('group amounts never mix currencies or turn missing values into zero', () => {
  const legs = [position(), position({ id: 'b', pnlCurrency: 'USDC', unrealizedPnl: '0.2' }), position({ id: 'c', unrealizedPnl: null })];
  assert.deepEqual(sumNative(legs, p => p.unrealizedPnl, p => p.pnlCurrency), [{ currency: 'USDT', value: null }, { currency: 'USDC', value: '0.2' }]);
  assert.equal(weightedPrice([position(), position({ quoteCurrency: 'USDC' })], 'entryPrice'), null);
  assert.equal(weightedPrice([position(), position({ entryPrice: null })], 'entryPrice'), null);
});

test('group net exposure uses direction while total notional uses positive normalized values', () => {
  const group = groupPositions([position(), position({ id: 'b', side: 'SHORT', baseQuantity: '0.1', notional: '10.2', positionValue: '-10.2', entryPrice: '102' })])[0];
  assert.equal(group.net, '0');
  assert.deepEqual(group.notional, [{ currency: 'USDT', value: '20.3' }]);
  assert.deepEqual(group.entry, { currency: 'USDT', value: '101' });
});

test('fee display prioritizes symbol overrides and retains rebates and absent fields', () => {
  const fees = [{ exchange_type: 'BINANCE', future_maker_fee: '-0.00001', future_taker_fee: '0.0005', special_fee_list: [{ symbol: 'BINANCE_PERP_BTC_USDT', maker_fee_rate: '0.0001', taker_fee_rate: null }] }];
  assert.deepEqual(instrumentFees(fees, 'BINANCE_PERP_BTC_USDT'), { maker: '0.0001', taker: '0.0005' });
  assert.deepEqual(instrumentFees(fees, 'BINANCE_PERP_ETH_USDT'), { maker: '-0.00001', taker: '0.0005' });
  assert.deepEqual(instrumentFees(fees, 'OKX_PERP_BTC_USDT'), { maker: null, taker: null });
});

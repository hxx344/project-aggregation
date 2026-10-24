import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFill, groupTradeEvents, TRADE_GAP_MS, TRADE_PAIRS } from '../modules/oil/trades.mjs';
import { fill } from './oil-trades-fixtures.mjs';

const bz = (overrides = {}) => fill({ key: 'bz', symbol: 'BZUSDT', base: 'BZ', quantityUnit: 'BZ', price: '110', side: 'sell', positionAfter: '-2', ...overrides });
test('same-named Asset projects cannot contribute opposite legs to the same venue', () => {
  const cl = fill({ sourceId: 'asset-project-a', price: '80' });
  const brent = bz({ sourceId: 'asset-project-b', price: '88' });
  const [event] = groupTradeEvents([cl, brent]);
  assert.equal(event.venues.length, 2);
  assert.deepEqual(new Set(event.venues.map(venue => venue.sourceId)), new Set(['asset-project-a', 'asset-project-b']));
  assert.equal(new Set(event.venues.map(venue => venue.key)).size, 2);
  assert.ok(event.venues.every(venue => venue.direction === '单腿' && venue.spread === null && venue.legs.length === 1));
  assert.equal(event.spread, null); assert.equal(event.spreadVenue, null);
  const [sameProject] = groupTradeEvents([cl, { ...brent, sourceId: cl.sourceId, source: '重命名后的账本' }]);
  assert.equal(sameProject.venues.length, 1); assert.equal(sameProject.spread, 10, 'display-name changes do not split stable project identity');
});

test('fill effects cover opening, reducing, closing, crossing zero and unknown reconstruction', () => {
  assert.deepEqual(classifyFill(fill()), [{ effect: 'open', quantity: '2' }]);
  assert.deepEqual(classifyFill(bz()), [{ effect: 'open', quantity: '2' }]);
  assert.deepEqual(classifyFill(fill({ positionBefore: '-2', positionAfter: '0' })), [{ effect: 'close', quantity: '2' }]);
  assert.deepEqual(classifyFill(fill({ positionBefore: '-3', positionAfter: '-1' })), [{ effect: 'close', quantity: '2' }]);
  assert.deepEqual(classifyFill(fill({ side: 'sell', positionBefore: '1.5', positionAfter: '-0.5' })), [{ effect: 'close', quantity: '1.5' }, { effect: 'open', quantity: '0.5' }]);
  assert.deepEqual(classifyFill(fill({ positionBefore: '-0.5', positionAfter: '1.5' })), [{ effect: 'close', quantity: '0.5' }, { effect: 'open', quantity: '1.5' }]);
  for (const item of [fill({ positionBefore: null, positionAfter: null }), fill({ positionAfter: '3' }), fill({ positionSide: 'short' })])
    assert.equal(classifyFill(item)[0].effect, 'unknown');
  assert.equal(classifyFill(fill({ quantity: '0.000000000000000001', positionBefore: '9007199254740993', positionAfter: '9007199254740993.000000000000000001' }))[0].effect, 'open');
});

test('event clustering uses adjacent ten-minute gaps across accounts and event types include mixed and unknown', () => {
  const at = Date.parse(fill().time);
  const timed = (i, ms) => fill({ key: String(i), accountId: String(i), time: new Date(at + ms).toISOString() });
  const events = groupTradeEvents([timed(4, 3 * TRADE_GAP_MS + 1), timed(2, TRADE_GAP_MS), timed(1, 0), timed(3, 2 * TRADE_GAP_MS)]);
  assert.equal(events.length, 2); assert.equal(events[0].fills.length, 3); assert.equal(events[0].type, 'entry');
  assert.equal(groupTradeEvents([fill({ positionBefore: '-2', positionAfter: '0' })])[0].type, 'exit');
  assert.equal(groupTradeEvents([fill(), bz({ positionBefore: '2', positionAfter: '0' })])[0].type, 'rebalance');
  assert.equal(groupTradeEvents([fill({ positionBefore: '-1', positionAfter: '1' })])[0].type, 'rebalance');
  assert.equal(groupTradeEvents([fill(), bz({ positionBefore: null, positionAfter: null })])[0].type, 'trade');
});

test('four legs across two venues remain separate with Binance spread preferred, including OKX contract units', () => {
  const event = groupTradeEvents([
    fill({ key: 'okx-cl', exchangeId: 'okx', exchange: 'OKX', quantity: '8', quantityUnit: '张', price: '90', positionAfter: '8' }),
    bz({ key: 'okx-bz', exchangeId: 'okx', exchange: 'OKX', quantity: '8', quantityUnit: '张', price: '108', positionAfter: '-8' }),
    fill(), bz(),
  ])[0];
  assert.equal(event.type, 'entry'); assert.equal(event.venues.length, 2);
  assert.equal(event.spread, 10); assert.equal(event.spreadVenue.exchangeId, 'binance');
  const okx = event.venues.find(venue => venue.exchangeId === 'okx');
  assert.equal(okx.spread, 20); assert.ok(okx.legs.every(leg => leg.quantity === '8' && leg.quantityUnit === '张'));
  assert.ok(event.venues.every(venue => venue.direction.startsWith('做空价差')));
  assert.equal(groupTradeEvents([fill(), bz({ side: 'buy', positionAfter: '2' })])[0].venues[0].direction, '双向或同向成交');
  assert.equal(groupTradeEvents([fill()])[0].venues[0].direction, '单腿');
});

test('weighted prices use exact quantities; unlike currency and native units cannot form a false pair', () => {
  const event = groupTradeEvents([fill({ quantity: '0.1', price: '90', positionAfter: '0.1' }), fill({ key: 'cl2', quantity: '0.2', price: '105', positionAfter: '0.2' }), bz()])[0];
  const cl = event.venues[0].legs.find(leg => leg.base === 'CL');
  assert.equal(cl.quantity, '0.3'); assert.equal(cl.price, '100'); assert.equal(event.spread, 10);
  const tiny = '0.000000000000000000000000000001';
  assert.equal(groupTradeEvents([fill({ price: tiny })])[0].venues[0].legs[0].price, tiny);
  assert.equal(groupTradeEvents([fill(), bz({ priceCurrency: 'USDC' })])[0].spread, null);
  const mixedUnits = groupTradeEvents([fill(), fill({ key: 'other', quantityUnit: '张' }), bz()])[0];
  assert.equal(mixedUnits.venues[0].legs.length, 3); assert.equal(mixedUnits.spread, null);
});

test('fees and PnL keep currency separation, unknown components and cross-zero costs counted once', () => {
  const event = groupTradeEvents([
    fill({ positionBefore: '-1', positionAfter: '1', fee: '-0.1', realizedPnl: '1.25' }),
    bz({ fee: '0.000001', feeCurrency: 'BNB', realizedPnl: null }),
    fill({ key: 'bybit', exchangeId: 'bybit', fee: '-0.2', priceCurrency: 'USDC', feeCurrency: 'USDC', realizedPnl: '2' }),
  ])[0];
  assert.deepEqual(Object.fromEntries(event.fees.map(value => [value.currency, value.amount])), { USDT: '-0.1', BNB: '0.000001', USDC: '-0.2' });
  assert.deepEqual(event.realizedPnl, [{ currency: 'USDT', amount: null, known: '1.25', unknown: true }, { currency: 'USDC', amount: '2', known: '2', unknown: false }]);
  assert.equal(groupTradeEvents([fill({ fee: null, feeCurrency: null })])[0].fees[0].amount, null);
  assert.equal(groupTradeEvents([fill({ fee: null, feeCurrency: null })])[0].fees[0].known, null);
  assert.equal(groupTradeEvents([fill({ fee: '-1', feeCurrency: null }), bz({ fee: '-2', feeCurrency: null })])[0].fees[0].amount, null, 'unknown currencies cannot be added together');
});

test('hynix pairs ADR with the ordinary share at ten ADRs per share and names the premium direction', () => {
  const adr = fill({ key: 'h|1', symbol: 'SKHYUSDT', base: 'SKHY', quantityUnit: 'SKHY', side: 'sell', quantity: '10', price: '42', positionBefore: '0', positionAfter: '-10' });
  const ordinary = fill({ key: 'h|2', symbol: 'SKHYNIXUSDT', base: 'SKHYNIX', quantityUnit: 'SKHYNIX', side: 'buy', quantity: '1', price: '400', positionBefore: '0', positionAfter: '1' });
  const [event] = groupTradeEvents([adr, ordinary], TRADE_PAIRS.hynix);
  assert.equal(event.type, 'entry');
  assert.ok(Math.abs(event.spread - 5) < 1e-9, '42 / (400 / 10) - 1 = 5%');
  assert.deepEqual(event.spreadVenue.prices, { left: 42, right: 400 });
  assert.equal(event.venues[0].direction, '做空溢价（空 ADR / 多正股）');
  assert.equal(groupTradeEvents([adr, ordinary])[0].spread, null, 'the oil pair never pairs hynix legs');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicTradeEvents, anthropicTradeMarkers } from '../lib/anthropic-trades.ts';
import { anthropicChartConfig, anthropicPoints } from '../lib/anthropic-history.ts';
import { tradeDetailLines } from '../modules/oil/trade-markers.mjs';
import { fill } from './oil-trades-fixtures.mjs';

const bar = Date.parse('2026-11-06T08:00:00.000Z'), step = 900_000;
const cex = (overrides = {}) => fill({ key: 'bn', symbol: 'ANTHROPICUSDT', base: 'ANTHROPIC', quantityUnit: 'ANTHROPIC',
  price: '1270', time: new Date(bar + 60_000).toISOString(), ...overrides });
const native = (leg, overrides = {}) => cex({ key: leg, sourceId: 'native', exchangeId: leg === 'rh' ? 'rh-lighter' : 'hyperliquid',
  exchange: leg === 'rh' ? 'Lighter RH' : 'Hyperliquid', symbol: leg === 'rh' ? 'ANTHROPIC' : leg === 'xyz' ? 'xyz:ANT' : 'io:ANTH',
  base: leg === 'rh' ? 'ANTHROPIC' : leg === 'xyz' ? 'XYZANT' : 'IOANTH', quantityUnit: leg === 'rh' ? 'ANTHROPIC' : leg === 'xyz' ? 'ANT' : 'ANTH',
  priceCurrency: leg === 'rh' ? 'USDG' : null, feeCurrency: leg === 'rh' ? 'USDG' : 'USDC', ...overrides });
const rows = [{ time: bar - step, binance: 1270, xyz: 80, io: 1670, rh: 835 }, { time: bar, binance: 1270, xyz: 80, io: 1670, rh: 835 }];
const markers = (fills, leg) => { const config = anthropicChartConfig(leg); return config.tradeMarkers(config.tradeEvents(fills), anthropicPoints(rows, leg)); };
const link = (overrides = {}) => ({ jobId: '11111111-1111-4111-8111-111111111111', phase: 0, batch: 0, comparisonLeg: 'rh', cex: 'binance', ...overrides });

test('verified Binance task is routed to RH even while native history is unavailable, never to xyz or io', () => {
  const item = cex({ orderId: '123', execution: link() });
  const [marker] = markers([item], 'rh');
  assert.match(marker.venueLabel, /Binance ↔ Lighter RH/); assert.equal(marker.value, 100); assert.equal(marker.event.spread, null);
  assert.equal(marker.event.time, Date.parse(item.time));
  for (const leg of ['xyz', 'io']) assert.deepEqual(markers([item], leg), []);
  const detail = tradeDetailLines(marker, String, anthropicChartConfig('rh').trade).join('\n');
  assert.match(detail, /工作台组合任务 11111111/); assert.match(detail, /订单 123/); assert.match(detail, /非双腿成交价差/);
});

test('linked fills group only within the same task phase and batch; unrelated manual fills remain separate', () => {
  const items = [cex({ execution: link() }), native('rh', { execution: link() }),
    cex({ key: 'next', execution: link({ batch: 1 }) }), cex({ key: 'other', execution: link({ jobId: '22222222-2222-4222-8222-222222222222' }) }),
    cex({ key: 'manual' })];
  const events = anthropicTradeEvents(items, 'rh');
  assert.equal(events.length, 4); assert.equal(events.find(event => event.fills.some(fill => fill.key === 'bn')).fills.length, 2);
  const unknown = markers(items, 'rh').find(marker => marker.event.fills[0].key === 'manual');
  assert.match(unknown.venueLabel, /组合关联未知/); assert.equal(unknown.value, null);
});

test('manual RH entry appears only on RH; the Binance hedge never appears on xyz/io charts', () => {
  const fills = [cex(), native('rh')];
  for (const leg of ['xyz', 'io', 'rh']) {
    const values = markers(fills, leg), plotted = values.filter(marker => marker.value !== null);
    assert.equal(plotted.length, leg === 'rh' ? 1 : 0, leg);
    assert.equal(values.find(marker => marker.event.fills[0].exchangeId === 'binance').usd, null);
    assert.ok(values.some(marker => marker.basis.includes('仅成交明细')), 'unassigned CEX history remains inspectable');
    if (leg === 'rh') {
      assert.equal(plotted[0].event.fills[0].key, 'rh'); assert.equal(plotted[0].event.type, 'entry');
      assert.equal(plotted[0].value, 100); assert.equal(plotted[0].venueLabel, 'Lighter RH');
    }
  }
});

test('native symbols route xyz, io and RH independently, including trades made outside this workbench', () => {
  const fills = [native('rh'), native('io'), native('xyz'), cex({ key: 'okx', exchangeId: 'okx', symbol: 'ANTHROPIC-USDT-SWAP', quantityUnit: '张', price: '127' })];
  for (const [leg, premium, spread] of [['xyz', 25, 20], ['io', 0, 0], ['rh', 100, 50]]) {
    const plotted = markers(fills, leg).filter(marker => marker.value !== null);
    assert.equal(plotted.length, 1); assert.equal(plotted[0].event.fills[0].key, leg);
    assert.equal(plotted[0].value, premium); assert.equal(plotted[0].usd, spread);
    assert.equal(plotted[0].event.spread, null, 'a single native fill never claims both legs executed');
  }
});

test('actual native position changes classify exits, cross-zero changes and unknown opening status', () => {
  const fills = [native('rh'), native('rh', { key: 'exit', time: new Date(bar + 120_000).toISOString(), side: 'sell', positionBefore: '2', positionAfter: '0' }),
    native('rh', { key: 'unknown', time: new Date(bar + 180_000).toISOString(), positionBefore: null, positionAfter: null }),
    native('rh', { key: 'cross', time: new Date(bar + 240_000).toISOString(), side: 'sell', positionBefore: '1', positionAfter: '-1' })];
  assert.deepEqual(anthropicTradeEvents(fills, 'rh').map(event => event.type), ['entry', 'exit', 'trade', 'rebalance']);
  assert.deepEqual(anthropicTradeEvents(fills, 'xyz'), []);
});

test('missing/open bars keep native fills listed without invented coordinates, and older fills stay outside range', () => {
  const points = anthropicPoints([rows[0], { ...rows[1], time: bar + step }], 'rh');
  const times = [bar - 2 * step, bar, bar + step, bar + 2 * step];
  const events = anthropicTradeEvents(times.map((time, index) => native('rh', { key: String(index), time: new Date(time).toISOString() })), 'rh');
  const values = anthropicTradeMarkers(events, points, 'rh');
  assert.deepEqual(values.map(marker => marker.event.time), times.slice(1));
  assert.deepEqual(values.map(marker => marker.value), [null, 100, null]);
  assert.deepEqual(values.map(marker => marker.usd), [null, 50, null]);
});

test('native detail preserves unknown currency, signed fees and true timestamps rather than an order price', () => {
  const [marker] = markers([native('xyz', { price: '83', fee: '-0.1', realizedPnl: null })], 'xyz');
  assert.equal(marker.value, 25); assert.equal(marker.event.time, bar + 60_000);
  const detail = tradeDetailLines(marker, value => String(value), anthropicChartConfig('xyz').trade).join('\n');
  assert.match(detail, /xyz:ANT 入场/); assert.match(detail, /@ 83 币种未知/);
  assert.match(detail, /手续费合计 -0.1 USDC/); assert.match(detail, /已实现盈亏合计 未知/);
});

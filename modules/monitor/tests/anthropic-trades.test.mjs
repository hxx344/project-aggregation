import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicTradeEvents, anthropicTradeMarkers } from '../lib/anthropic-trades.ts';
import { anthropicChartConfig, anthropicPoints } from '../lib/anthropic-history.ts';
import { tradeDetailLines } from '../modules/oil/trade-markers.mjs';
import { fill } from './oil-trades-fixtures.mjs';

const bar = Date.parse('2026-11-06T08:00:00.000Z'), step = 900_000;
const ant = (overrides = {}) => fill({ key: 'ant-entry', symbol: 'ANTHROPICUSDT', base: 'ANTHROPIC', quantityUnit: 'ANTHROPIC',
  price: '1270', time: new Date(bar + 60_000).toISOString(), ...overrides });
const rows = [{ time: bar - step, binance: 1270, xyz: 80, io: 1670, rh: 835 }, { time: bar, binance: 1270, xyz: 80, io: 1670, rh: 835 }];

test('ANT classifies actual position changes and keeps unknown and cross-zero fills distinct', () => {
  const events = anthropicTradeEvents([
    ant(), ant({ key: 'exit', time: new Date(bar + 120_000).toISOString(), side: 'sell', positionBefore: '2', positionAfter: '0' }),
    ant({ key: 'unknown', time: new Date(bar + 180_000).toISOString(), positionBefore: null, positionAfter: null }),
    ant({ key: 'cross', time: new Date(bar + 240_000).toISOString(), side: 'sell', positionBefore: '1', positionAfter: '-1' }),
    fill({ time: new Date(bar).toISOString() }), ant({ key: 'token', symbol: 'ANTUSDT', base: 'ANT' }),
    ant({ key: 'bybit', exchangeId: 'bybit' }),
  ]);
  assert.deepEqual(events.map(event => event.type), ['entry', 'exit', 'trade', 'rebalance']);
  assert.equal(events[0].time, bar + 60_000);
  assert.ok(events.every(event => event.spread === null && event.spreadVenue === null));
});

test('ANT markers follow the selected closed 15-minute chart and never use native trade price as spread', () => {
  const events = anthropicTradeEvents([ant()]);
  for (const [leg, premium, spread] of [['xyz', 25, 20], ['io', 0, 0], ['rh', 100, 50]]) {
    const config = anthropicChartConfig(leg), points = anthropicPoints(rows, leg);
    const [marker] = config.tradeMarkers(events, points);
    assert.equal(config.tradeMarket, 'anthropic');
    assert.equal(marker.value, premium); assert.equal(marker.usd, spread);
    assert.equal(marker.basis, '图表溢价率（非成交价差）');
    assert.equal(marker.event.fills[0].price, '1270', 'native price stays unchanged in details');
    assert.match(config.trade.note, /非|不代表/);
  }
});

test('OKX keeps contracts, account identity, fees and prices separate from Binance', () => {
  const events = anthropicTradeEvents([ant(), ant({ key: 'okx', exchangeId: 'okx', exchange: 'OKX', accountId: 'okx-main', scope: 'swap',
    symbol: 'ANTHROPIC-USDT-SWAP', quantityUnit: '张', price: '127', fee: '-0.3', realizedPnl: '4', stale: true })]);
  const [event] = events;
  assert.equal(event.venues.length, 2); assert.equal(event.spread, null);
  assert.equal(event.fees[0].amount, '-0.4'); assert.equal(event.realizedPnl[0].amount, '4');
  const [marker] = anthropicTradeMarkers(events, anthropicPoints(rows, 'xyz'));
  assert.equal(marker.value, 25); assert.equal(marker.usd, 20); assert.equal(event.stale, true);
  const details = tradeDetailLines(marker, value => String(value), anthropicChartConfig('xyz').trade).join('\n');
  assert.match(details, /2 张 @ 127 USDT/); assert.match(details, /成交价差 未知/); assert.match(details, /手续费合计 -0.4 USDT/);
});

test('missing and open bars stay listed without fabricated marker coordinates; older fills stay outside range', () => {
  const points = anthropicPoints([rows[0], { ...rows[1], time: bar + step }], 'xyz');
  const times = [bar - 2 * step, bar, bar + step, bar + 2 * step];
  const events = anthropicTradeEvents(times.map((time, index) => ant({ key: String(index), time: new Date(time).toISOString() })));
  const markers = anthropicTradeMarkers(events, points);
  assert.deepEqual(markers.map(marker => marker.event.time), times.slice(1));
  assert.deepEqual(markers.map(marker => marker.value), [null, 25, null]);
  assert.deepEqual(markers.map(marker => marker.usd), [null, 20, null]);
  assert.deepEqual(anthropicTradeMarkers(events, []), []);
});

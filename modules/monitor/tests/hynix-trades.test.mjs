import test from 'node:test';
import assert from 'node:assert/strict';
import { hynixTradeEvents, hynixTradeMarkers, HOUR_MS } from '../lib/hynix-trades.ts';
import { fill } from './oil-trades-fixtures.mjs';

const hour = Date.parse('2026-10-01T08:00:00.000Z');
const point = (time, premium, spread) => ({ time, adr: 42, ordinary: 400, equivalent: 40, spread, premium });
const points = [point(hour - HOUR_MS, 3, 1.2), point(hour, 4, 1.6)];
const leg = (key, time, overrides) => fill({ key, time, ...overrides });
const pair = (key, time, adrPrice = '42') => [
  leg(`${key}|adr`, time, { symbol: 'SKHYUSDT', base: 'SKHY', quantityUnit: 'SKHY', side: 'sell', quantity: '10', price: adrPrice, positionBefore: '0', positionAfter: '-10' }),
  leg(`${key}|ord`, time, { symbol: 'SKHYNIXUSDT', base: 'SKHYNIX', quantityUnit: 'SKHYNIX', side: 'buy', quantity: '1', price: '400', positionBefore: '0', positionAfter: '1' }),
];

test('a fill belongs to the closed hour bar containing it', () => {
  const inside = new Date(hour + 45 * 60_000).toISOString();
  const [marker] = hynixTradeMarkers(hynixTradeEvents(pair('a', inside)), points);
  assert.equal(marker.chartSpread, 4, 'uses the containing bar, not the nearer next hour');
  assert.ok(Math.abs(marker.value - 5) < 1e-9);
  assert.equal(marker.basis, '成交溢价率');
  assert.ok(Math.abs(marker.usd - 2) < 1e-9, 'USD spread = ADR − ordinary ÷ 10 from fill prices');
  const before = new Date(hour - HOUR_MS - 1).toISOString();
  assert.deepEqual(hynixTradeMarkers(hynixTradeEvents(pair('b', before)), points), [], 'fills before the chart range are hidden');
});

test('fills in the still-open hour stay visible with their own prices and no chart value', () => {
  const open = new Date(hour + HOUR_MS + 20 * 60_000).toISOString();
  const [marker] = hynixTradeMarkers(hynixTradeEvents(pair('c', open, '44')), points);
  assert.equal(marker.chartSpread, null);
  assert.ok(Math.abs(marker.value - 10) < 1e-9); assert.ok(Math.abs(marker.usd - 4) < 1e-9);
  const [adrOnly] = pair('d', open);
  const [unpriced] = hynixTradeMarkers(hynixTradeEvents([adrOnly]), points);
  assert.equal(unpriced.value, null, 'listed, but without a chart position'); assert.equal(unpriced.usd, null);
});

test('a single leg falls back to the chart values of its bar, and a gap hour has none', () => {
  const [adrOnly] = pair('b', new Date(hour + 60_000).toISOString());
  const [marker] = hynixTradeMarkers(hynixTradeEvents([adrOnly]), points);
  assert.equal(marker.value, 4); assert.equal(marker.basis, '图表溢价率'); assert.equal(marker.usd, 1.6);
  const gapped = [point(hour - 3 * HOUR_MS, 2, 1), point(hour, 4, 1.6)];
  const [gap] = hynixTradeMarkers(hynixTradeEvents([leg('c', new Date(hour - HOUR_MS).toISOString(), { symbol: 'SKHYUSDT', base: 'SKHY', quantityUnit: 'SKHY' })]), gapped);
  assert.equal(gap.value, null); assert.equal(gap.usd, null);
});

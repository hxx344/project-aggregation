import test from 'node:test';
import assert from 'node:assert/strict';
import { perpetualChartUrl, perpetualWorkspaceUrl, readPerpetualChartSelection, validPerpetualChartSelection } from '../lib/perpetual-chart-state.ts';

const selected = { base: 'SKHX', longKey: 'binance:SKHXUSDT', shortKey: 'hyperliquid:xyz:SKHX', days: 7 };

test('chart links round-trip exact contracts and direction without changing unrelated monitor state', () => {
  const url = new URL(perpetualChartUrl('https://local.example/?monitor=oil&goldOil=bz&symbol=SKHX#panel', selected));
  assert.deepEqual(readPerpetualChartSelection(url.searchParams), selected);
  assert.equal(url.searchParams.get('monitor'), 'perpetual');
  assert.equal(url.searchParams.get('goldOil'), 'bz'); assert.equal(url.hash, '#panel');
  const reversed = { ...selected, longKey: selected.shortKey, shortKey: selected.longKey, days: 30 };
  assert.deepEqual(readPerpetualChartSelection(new URL(perpetualChartUrl(url.href, reversed)).searchParams), reversed);
  const back = new URL(perpetualChartUrl(url.href, null));
  assert.equal(readPerpetualChartSelection(back.searchParams), null);
  assert.equal(back.searchParams.has('chartLong'), false); assert.equal(back.searchParams.get('symbol'), 'SKHX');
});

test('malformed, duplicate and same-venue chart selections do not initiate requests', () => {
  for (const update of [{ days: 1 }, { days: '7' }, { base: '' }, { longKey: 'https://host/path' }, { shortKey: 'binance:SKHXUSDC' }, { longKey: 'binance:BTC USDT' }, { base: '<script>' }]) {
    assert.equal(validPerpetualChartSelection({ ...selected, ...update }), false);
  }
  const url = new URL(perpetualChartUrl('https://local.example', selected));
  url.searchParams.append('chartLong', selected.longKey);
  assert.equal(readPerpetualChartSelection(url.searchParams), null);
  url.searchParams.delete('chartLong'); url.searchParams.set('chartLong', selected.longKey);
  url.searchParams.set('chartDays', '07'); assert.equal(readPerpetualChartSelection(url.searchParams), null);
});

test('positions remains an explicit history destination and leaving it clears workspace state', () => {
  const chart = perpetualChartUrl('https://local.example/?monitor=perpetual&symbol=BTC', selected);
  const positions = new URL(perpetualWorkspaceUrl(chart, 'positions'));
  assert.equal(positions.searchParams.get('perpView'), 'positions');
  assert.equal(positions.searchParams.has('chartLong'), false);
  assert.equal(positions.searchParams.get('symbol'), 'BTC');
  const opportunities = new URL(perpetualWorkspaceUrl(positions.href, 'opportunities'));
  assert.equal(opportunities.searchParams.has('perpView'), false);
  assert.equal(readPerpetualChartSelection(opportunities.searchParams), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ANTHROPIC_SHARES, anthropicChartRows, anthropicPremium, anthropicSharesPerUnit, perShare } from '../modules/anthropic/market.mjs';
import { anthropicPoints } from '../lib/anthropic-history.ts';
import { createAnthropicSummaryReader } from '../lib/monitor-summary.ts';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const rows = [{ time: Date.UTC(2026, 10, 10, 0), binance: 1200, xyz: 80, io: 2000, rh: 800 }];

test('custom share assumptions convert all comparisons and history with the same units and direction', () => {
  const shares = { outstanding: 10, diluted: 20 };
  assert.equal(perShare('binance', 1200, shares), 120);
  assert.equal(perShare('xyz', 80, shares), 80);
  assert.equal(perShare('io', 2000, shares), 100);
  assert.equal(perShare('rh', 800, shares), 40);
  for (const [leg, premium, equivalent] of [['xyz', 50, 80], ['io', 20, 100], ['rh', 200, 40]]) {
    close(anthropicPremium(1200, rows[0][leg], leg, shares), premium);
    const [point] = anthropicPoints(rows, leg, shares);
    close(point.premium, premium); close(point.adr, 120); close(point.equivalent, equivalent);
    close(point.spread, 120 - equivalent);
    assert.equal(point.time, rows[0].time);
  }
  assert.equal(rows[0].binance, 1200, 'history stores native prices, not converted values');
});

test('changing only shares recomputes retained candle rows and the overview trend', () => {
  const read = createAnthropicSummaryReader();
  const summary = shares => {
    const points = anthropicChartRows(rows, 'rh', shares).map(row => ({ time: row.time, value: row.premium }));
    return read({ status: 'live', fetchedAt: new Date(rows[0].time).toISOString(), premiums: { rh: points[0].value }, trendLeg: 'Lighter RH',
      sharesNote: `流通 ${shares.outstanding}、完全稀释 ${shares.diluted}`, history: { points, status: 'live', fetchedAt: new Date(rows[0].time).toISOString() } });
  };
  const first = summary({ outstanding: 10, diluted: 20 }), next = summary({ outstanding: 12, diluted: 30 });
  assert.equal(first.metrics[2].value, '+200.00%'); assert.equal(next.metrics[2].value, '+275.00%');
  assert.notStrictEqual(first.trend, next.trend);
  assert.match(next.note, /流通 12、完全稀释 30/);
});

test('unknown or invalid assumptions hide every derived price, premium and history', () => {
  for (const shares of [null, { outstanding: 0, diluted: 20 }, { outstanding: 10, diluted: 9 }, { outstanding: 10, diluted: 101 },
    { outstanding: NaN, diluted: 20 }, { outstanding: 10, diluted: Infinity }, { outstanding: '10', diluted: 20 }]) {
    for (const leg of ['xyz', 'io', 'rh']) {
      assert.equal(anthropicPremium(1200, rows[0][leg], leg, shares), null);
      assert.equal(perShare(leg, rows[0][leg], shares), null);
      assert.deepEqual(anthropicChartRows(rows, leg, shares), []);
    }
  }
  for (const price of [null, undefined, 0, -1, NaN, Infinity]) assert.equal(anthropicPremium(1200, price, 'xyz', ANTHROPIC_SHARES), null);
  assert.equal(anthropicSharesPerUnit('binance'), 12.7);
  assert.equal(anthropicSharesPerUnit('rh'), 16.7);
});

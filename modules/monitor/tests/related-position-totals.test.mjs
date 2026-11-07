import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedPositionTotals } from '../lib/related-position-totals.ts';

const cycle = (overrides = {}) => ({ status: 'complete', since: '2026-11-01T00:00:00.000Z', closedQuantity: '1', closePrice: '1200',
  realizedPnl: '10', fees: '-2', funding: '1', net: '9', currency: 'USDT', note: null, updatedAt: '2026-11-06T00:00:00.000Z', ...overrides });
const item = (overrides = {}) => ({ key: 'bn', source: 'Asset', exchange: 'Binance', exchangeId: 'binance', symbol: 'ANTHROPICUSDT', base: 'ANTHROPIC',
  side: 'long', quantity: '2', quantityUnit: 'ANTHROPIC', entryPrice: '1200', markPrice: '1210', unrealizedPnl: '20', pnlCurrency: 'USDT',
  updatedAt: '2026-11-06T00:00:00.000Z', stale: false, cycle: cycle(), ...overrides });

test('same-currency ANT related positions sum signed current-cycle cash flows and unrealized PnL', () => {
  const [totals] = relatedPositionTotals([item(), item({ key: 'okx', exchangeId: 'okx', unrealizedPnl: '-5', side: 'short',
    cycle: cycle({ realizedPnl: '-3', fees: '-1', funding: '2', net: '-2' }) })]);
  assert.equal(totals.count, 2); assert.equal(totals.unrealized, 15);
  assert.equal(totals.realized, 7); assert.equal(totals.fees, -3); assert.equal(totals.funding, 3);
  assert.equal(totals.net, 7); assert.equal(totals.total, 22); assert.equal(totals.realizedStatus, 'complete');
});

test('USDT, USDC, USDG and unknown settlement currency never combine', () => {
  const totals = relatedPositionTotals(['USDT', 'USDC', 'USDG', null].map((currency, index) => item({ key: String(index), pnlCurrency: currency, cycle: cycle({ currency }) })));
  assert.deepEqual(totals.map(total => total.currency), ['USDT', 'USDC', 'USDG', null]);
  assert.deepEqual(totals.map(total => total.total), [29, 29, 29, null]);
  assert.equal(totals[3].unrealized, null); assert.equal(totals[3].net, null);
});

test('missing cycle, missing amounts, partial statistics and incomplete lists cannot claim complete total PnL', () => {
  const cases = [
    { cycle: undefined }, { cycle: cycle({ status: 'loading' }) }, { cycle: cycle({ status: 'partial' }) },
    { cycle: cycle({ currency: 'USDC' }) }, { cycle: cycle({ currency: null }) }, { cycle: cycle({ net: null }) }, { unrealizedPnl: null },
  ];
  for (const change of cases) {
    const [total] = relatedPositionTotals([item(), item({ key: 'other', ...change })]);
    assert.equal(total.total, null, JSON.stringify(change));
  }
  const [incomplete] = relatedPositionTotals([item()], true);
  assert.equal(incomplete.unrealized, 20); assert.equal(incomplete.total, null);
  const [missing] = relatedPositionTotals([item(), item({ cycle: undefined })]);
  assert.equal(missing.realized, null); assert.equal(missing.fees, null); assert.equal(missing.funding, null); assert.equal(missing.net, null);
});

test('zero amounts remain zero, stale inputs retain their qualification and invalid numbers cannot escape', () => {
  const [zero] = relatedPositionTotals([item({ unrealizedPnl: '0', stale: true, cycle: cycle({ realizedPnl: '0', fees: '0', funding: '0', net: '0' }) })]);
  assert.equal(zero.total, 0); assert.equal(zero.unrealizedStale, true);
  for (const unrealizedPnl of ['', 'NaN', 'Infinity']) assert.equal(relatedPositionTotals([item({ unrealizedPnl })])[0].total, null);
  assert.deepEqual(relatedPositionTotals([]), []);
});

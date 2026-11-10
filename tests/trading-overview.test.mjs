import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Resolve the frontend's extensionless TS imports under Node's native type stripping.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('./') && context.parentURL?.includes('/src/') && error.code === 'ERR_MODULE_NOT_FOUND') return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { roundedAmount } = await import('../src/trading-format.ts');
const { liquidationDistance, oldestRead, overviewPnl, sideNotional, worstState } = await import('../src/trading-overview.ts');

test('compact amounts round half-up on the decimal string without float drift', () => {
  assert.equal(roundedAmount('32.123456789012345678', true), '+32.12');
  assert.equal(roundedAmount('1234567.995'), '1,234,568');
  assert.equal(roundedAmount('-0.004', true), '0');
  assert.equal(roundedAmount('-12.345', true), '−12.35');
  assert.equal(roundedAmount('90071992547409931.125'), '90,071,992,547,409,931.13');
  assert.equal(roundedAmount(null), '—');
  assert.equal(roundedAmount('abc'), '—');
});

test('liquidation distance needs both positive prices', () => {
  assert.equal(liquidationDistance('100', '80'), '20.00');
  assert.equal(liquidationDistance('100', '125'), '25.00');
  assert.equal(liquidationDistance('100', null), null);
  assert.equal(liquidationDistance('100', '0'), null);
  assert.equal(liquidationDistance(null, '80'), null);
});

test('a failed connected source is never hidden behind live or unconnected ones', () => {
  assert.equal(worstState(['live', 'error', 'unconfigured']), 'error');
  assert.equal(worstState(['live', 'unconfigured']), 'live');
  assert.equal(worstState(['unconfigured', 'unconfigured']), 'unconfigured');
  assert.equal(worstState(['live', 'stale']), 'stale');
  assert.equal(worstState([]), 'unconfigured');
});

test('freshness reports the oldest read and side totals refuse unknown notionals', () => {
  assert.equal(oldestRead(['2026-11-09T08:00:05Z', null, '2026-11-09T08:00:01Z', 'bad']), '2026-11-09T08:00:01Z');
  assert.equal(oldestRead([null]), null);
  const row = (side, notional) => ({ id: side + notional, exchange: 'Binance', symbol: 'X', side, quantity: '1', unit: '', notional, unrealizedPnl: null, distancePercent: null });
  assert.deepEqual(sideNotional([row('long', '100.5'), row('long', '0.25'), row('short', '99')]), { long: '100.75', short: '99.00' });
  assert.deepEqual(sideNotional([row('long', null), row('short', '1')]), { long: null, short: '1.00' });
});

const market = (values, extra = {}) => ({ id: 'oil', state: 'live', error: null,
  rows: values.map(unrealizedPnl => ({ unrealizedPnl, pnlCurrency: 'USDT' })), ...extra });

test('overview sums raw decimal PnL exactly before rounding, including screenshot pairs', () => {
  for (const [values, expected] of [
    [['-3122.03', '5303.24'], '+2,181.21'],
    [['816.73', '-733.99'], '+82.74'],
    [['-811.48', '4349.22'], '+3,537.74'],
    [['0.004', '0.004'], '+0.01'],
    [['90071992547409931.125', '-90071992547409930.12'], '+1.01'],
    [['-12.345', '0'], '−12.35'],
    [['-0.004', '0.004'], '0'],
    [['1.25', '-2', '3.005', '-0.005'], '+2.25'],
  ]) {
    const total = overviewPnl(market(values));
    assert.equal(roundedAmount(total.value, true), expected);
    assert.equal(total.currency, 'USDT');
    assert.equal(total.note, null);
  }
});

test('overview refuses missing or malformed amounts and incomplete source states', () => {
  for (const value of [null, '', 'NaN', 'Infinity', '1e3', ' 2', 'abc']) {
    assert.equal(overviewPnl(market(['12', value])).value, null);
  }
  assert.equal(overviewPnl(market([])).value, null);
  for (const state of ['stale', 'error', 'loading', 'unconfigured']) {
    assert.equal(overviewPnl(market(['12', '-1'], { state })).value, null);
  }
  assert.equal(overviewPnl(market(['12', '-1'], { error: '读取失败' })).value, null);
  assert.equal(overviewPnl(market(['0', '-0'])).value, '0');
});

test('overview keeps settlement units and restricts the ANT 1:1 estimate to USDT/USDG', () => {
  const rows = [
    { unrealizedPnl: '-811.48', pnlCurrency: 'USDT' },
    { unrealizedPnl: '4349.22', pnlCurrency: 'USDG' },
  ];
  assert.deepEqual(overviewPnl(market([], { id: 'anthropic', rows })), {
    value: '3537.74', currency: 'USDT', note: '估算：USDG 按 1:1 折算 USDT',
  });
  assert.equal(overviewPnl(market([], { rows })).value, null);
  assert.deepEqual(overviewPnl(market([], { id: 'anthropic', rows: rows.map(row => ({ ...row, pnlCurrency: 'USDG' })) })), {
    value: '3537.74', currency: 'USDG', note: null,
  });
  for (const pnlCurrency of [null, '', 'USDC']) {
    const total = overviewPnl(market([], { id: 'anthropic', rows: [rows[0], { ...rows[1], pnlCurrency }] }));
    assert.equal(total.value, null);
    assert.equal(total.currency, null);
    assert.ok(total.note);
  }
});

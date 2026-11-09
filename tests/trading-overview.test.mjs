import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Resolve the frontend's extensionless TS imports under Node's native type stripping.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('./') && context.parentURL?.includes('/src/') && error.code === 'ERR_MODULE_NOT_FOUND') return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { roundedAmount } = await import('../src/trading-format.ts');
const { liquidationDistance, oldestRead, sideNotional, worstState } = await import('../src/trading-overview.ts');

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

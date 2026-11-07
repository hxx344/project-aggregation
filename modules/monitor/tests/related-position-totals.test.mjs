import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedAnthropicPair } from '../lib/related-position-totals.ts';

const now = Date.parse('2026-11-07T12:54:07.000Z');
const cycle = (overrides = {}) => ({ status: 'complete', since: '2026-11-06T19:14:00.000Z', closedQuantity: '0', closePrice: null,
  realizedPnl: '0', fees: '-14.77', funding: '3.28', net: '-11.49', currency: 'USDT', note: null, updatedAt: new Date(now).toISOString(), ...overrides });
const bn = (overrides = {}) => ({ key: 'bn', source: 'Asset', exchange: 'Binance', exchangeId: 'binance', symbol: 'ANTHROPICUSDT', base: 'ANTHROPIC',
  side: 'short', quantity: '33.84', quantityUnit: 'ANTHROPIC', entryPrice: '1349.8098', markPrice: null, unrealizedPnl: '-1298.80', pnlCurrency: 'USDT',
  updatedAt: new Date(now).toISOString(), stale: false, cycle: cycle(), ...overrides });
const rh = (overrides = {}) => bn({ key: 'rh', exchange: 'Lighter RH', exchangeId: 'rh-lighter', symbol: 'ANTHROPIC', side: 'long',
  quantity: '24.73130', entryPrice: '1530.9', unrealizedPnl: '1705.13', pnlCurrency: 'USDG', cycle: undefined, ...overrides });
const quote = { premiums: { xyz: 5, io: 10, rh: 12 }, fetchedAt: new Date(now).toISOString(), staleAfterMs: 35000, stale: false };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('the reported Binance/RH position has +406.33 unrealized and +394.84 known net under explicit 1:1 estimate', () => {
  const { pair, reason } = relatedAnthropicPair([bn(), rh()], quote, false, now);
  assert.equal(reason, ''); assert.equal(pair.label, 'Binance ↔ Lighter RH');
  close(pair.unrealized.value, 406.33); assert.equal(pair.unrealized.complete, true);
  close(pair.net.value, -11.49); assert.equal(pair.net.complete, false);
  close(pair.knownTotal, 394.84); assert.equal(pair.total, null);
  assert.deepEqual(pair.missing, ['Lighter RH：已实现、手续费、资金费']);
  close(pair.opening, (1349.8098 / 12.7 / (1530.9 / 16.7) - 1) * 100);
  assert.equal(pair.current, 12); assert.equal(pair.closing, null); assert.equal(pair.narrowingFavors, true);
  close(pair.shares[0], 429.768); close(pair.shares[1], 413.01271);
});

test('complete current cycles produce combined net, fees, funding and closing premium exactly once', () => {
  const { pair } = relatedAnthropicPair([bn({ cycle: cycle({ closedQuantity: '1', closePrice: '1270' }) }),
    rh({ cycle: cycle({ currency: 'USDG', realizedPnl: '12', fees: '-2', funding: '1', net: '11', closedQuantity: '1', closePrice: '1670' }) })], quote, false, now);
  close(pair.realizedPnl.value, 12); close(pair.fees.value, -16.77); close(pair.funding.value, 4.28);
  close(pair.net.value, -0.49); close(pair.total, 405.84); close(pair.knownTotal, pair.total);
  close(pair.closing, 0);
});

test('no shared Binance leg can be counted twice across comparison contracts or duplicate accounts', () => {
  const io = rh({ key: 'io', exchangeId: 'hyperliquid', symbol: 'io:ANTH', base: 'IOANTH' });
  for (const items of [[bn(), rh(), io], [bn(), bn({ key: 'bn2' }), rh()], [bn(), rh(), rh({ key: 'rh2' })]]) {
    const result = relatedAnthropicPair(items, quote, false, now);
    assert.equal(result.pair, null); assert.match(result.reason, /无法唯一分配/);
  }
  assert.equal(relatedAnthropicPair([bn(), rh()], quote, true, now).pair, null);
  assert.match(relatedAnthropicPair([bn(), rh({ side: 'short' })], quote).reason, /同向/);
  assert.match(relatedAnthropicPair([rh()], quote).reason, /缺少/);
});

test('unknown currencies and partial or missing flows stay visibly incomplete; genuine zero remains zero', () => {
  const { pair: unknown } = relatedAnthropicPair([bn(), rh({ pnlCurrency: null })], quote, false, now);
  assert.equal(unknown.unrealized.complete, false); assert.equal(unknown.total, null); close(unknown.knownTotal, -1310.29);
  assert.match(unknown.missing[0], /结算币种/);
  const { pair: partial } = relatedAnthropicPair([bn(), rh({ cycle: cycle({ status: 'partial', currency: 'USDG', realizedPnl: '0', fees: null, funding: '2', net: null }) })], quote, false, now);
  close(partial.knownTotal, 396.84); assert.equal(partial.total, null); assert.match(partial.missing[0], /手续费.*不完整/);
  const zeroCycle = cycle({ currency: 'USDG', realizedPnl: '0', fees: '0', funding: '0', net: '0' });
  const { pair: zero } = relatedAnthropicPair([bn({ unrealizedPnl: '0', cycle: { ...zeroCycle, currency: 'USDT' } }), rh({ unrealizedPnl: '0', cycle: zeroCycle })]);
  assert.equal(zero.total, 0); assert.equal(zero.knownTotal, 0);
});

test('current quote uses actual pair identity and preserves staleness instead of following another chart', () => {
  const { pair } = relatedAnthropicPair([bn(), rh({ stale: true })], quote, false, now + 35001);
  assert.equal(pair.current, 12); assert.equal(pair.currentStale, true); assert.equal(pair.stale, true);
  assert.equal(relatedAnthropicPair([bn(), rh()], undefined, false, now).pair.current, null);
  const { pair: xyz } = relatedAnthropicPair([bn(), rh({ symbol: 'xyz:ANT', base: 'XYZANT', exchangeId: 'hyperliquid', entryPrice: '100', pnlCurrency: null })], quote, false, now);
  assert.equal(xyz.current, 5); assert.equal(xyz.leg, 'xyz'); assert.equal(xyz.total, null);
});

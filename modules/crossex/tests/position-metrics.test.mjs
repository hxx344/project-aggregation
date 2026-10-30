import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import Decimal from 'decimal.js';

const sourceResolution = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(context.parentURL?.endsWith('/src/position-view.ts') && ['./live-display', './position-actions'].includes(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { groupPositions } = await import('../src/position-view.ts');
sourceResolution.deregister();

const now = 1800000000000, day = 86400000;
const long = (changes = {}) => ({ id: 'long', symbol: 'BINANCE_FUTURE_BTC_USDT', exchange: 'binance', side: 'LONG',
  quantity: '2', baseQuantity: '2', baseCurrency: 'BTC', quoteCurrency: 'USDT', entryPrice: '100', markPrice: '100',
  unrealizedPnl: '0', pnlCurrency: 'USDT', margin: '10', marginCurrency: 'USDT', liquidationPrice: null,
  external: true, updatedAt: now, openedAt: now - day, fundingFee: '-0.01', realizedPnl: '999999', notional: '200', ...changes });
const short = (changes = {}) => long({ id: 'short', symbol: 'OKX_FUTURE_BTC_USDT', exchange: 'okx', side: 'SHORT',
  entryPrice: '110', markPrice: '108', unrealizedPnl: '4', fundingFee: '0.03', openedAt: now - day / 2, notional: '216', ...changes });
const fundingLeg = (position, rate, changes = {}) => ({ exchange: position.exchange, symbol: position.symbol,
  quoteCurrency: position.quoteCurrency, rate, intervalHours: 8, normalized8hBps: 12345,
  fundingAt: now - 100, nextFundingAt: now + 3600000, ...changes });
const opportunity = (changes = {}) => ({ id: 'funding-pair', base: 'BTC', long: fundingLeg(long(), 0.0001), short: fundingLeg(short(), 0.0003),
  equivalent8hBps: 98765, grossBps: null, asOf: now - 100, expiresAt: now + 5000, eligible: true, reason: '', ...changes });
const metrics = (legs = [long(), short()], options = {}) => groupPositions(legs, { now, fundingOpportunities: [opportunity()], ...options })[0].metrics;
const positionRate = (position, rate, changes = {}) => ({ ...fundingLeg(position, rate), expiresAt: now + 5000, ...changes });

test('fractional client clock preserves holding time and funding while source timestamps stay strict', () => {
  const rates = [positionRate(long(), 0.0001), positionRate(short(), 0.0003)];
  for (const options of [{}, { positionFundingRates: rates }]) {
    const result = metrics(undefined, { ...options, now: now + 0.125 });
    assert.equal(result.holdingMs, day + 0.125);
    assert.equal(result.openedAt, now - day);
    assert.ok(new Decimal(result.annualizedReturn).gt(0));
    assert.equal(result.fundingRate8h, '0.0002');
    assert.equal(result.healthScore, 100);
  }
  assert.equal(metrics([long({ openedAt: now - day + 0.125 }), short()]).holdingMs, null);
  assert.equal(metrics(undefined, { positionFundingRates: [rates[0], { ...rates[1], fundingAt: now - 0.125 }] }).fundingRate8h, null);
  for (const clock of [0, -1, NaN, Infinity]) {
    const result = metrics(undefined, { now: clock, positionFundingRates: rates });
    assert.equal(result.holdingMs, null);
    assert.equal(result.fundingRate8h, null);
    assert.equal(result.health, 'unknown');
  }
});

test('dedicated position rates retain zero, equal and negative directed rates outside opportunity rankings', () => {
  for (const [longRate, shortRate, expected] of [[0, 0, '0'], [0.0001, 0.0001, '0'], [-0.0002, -0.0002, '0'],
    [0, 0.0001, '0.0001'], [0.0001, 0, '-0.0001'], [-0.0001, -0.0002, '-0.0001']]) {
    const result = metrics(undefined, { positionFundingRates: [positionRate(short(), shortRate), positionRate(long(), longRate)] });
    assert.equal(result.fundingRate8h, expected);
    assert.equal(result.expectedFundingAnnualized, new Decimal(expected).mul(1095).toFixed());
    assert.equal(result.healthScore, expected.startsWith('-') ? 75 : 100);
  }
  const normalized = metrics(undefined, { positionFundingRates: [
    positionRate(long(), 0.0001, { intervalHours: 1 }), positionRate(short(), 0.0002, { intervalHours: 4 })] });
  assert.equal(normalized.fundingRate8h, '-0.0004');
});

test('provided position-rate list is authoritative and does not fall back when empty or incomplete', () => {
  for (const positionFundingRates of [[], [positionRate(long(), 0)], [positionRate(short(), 0)]]) {
    const result = metrics(undefined, { positionFundingRates });
    assert.equal(result.fundingRate8h, null);
    assert.equal(result.health, 'unknown');
  }
  assert.equal(metrics(undefined, { positionFundingRates: undefined }).fundingRate8h, '0.0002');
});

test('each dedicated rate needs exact identity, independent freshness and a valid interval', () => {
  const invalid = [{ exchange: 'binance' }, { symbol: 'OKX_FUTURE_ETH_USDT' }, { quoteCurrency: 'USDC' },
    { expiresAt: now }, { expiresAt: null }, { expiresAt: now + 0.125 }, { fundingAt: now - 300000 },
    { fundingAt: now + 1001 }, { fundingAt: 0 }, { intervalHours: 0 }, { intervalHours: null }, { rate: null }];
  for (const changes of invalid) {
    const result = metrics(undefined, { positionFundingRates: [positionRate(long(), 0.0001), positionRate(short(), 0.0003, changes)] });
    assert.equal(result.fundingRate8h, null);
    assert.equal(result.nextFundingAt, null);
    assert.equal(result.healthScore, null);
  }
  // Quote/BBO health is independent of the dedicated funding certificate.
  const independent = metrics(undefined, { marketStale: true,
    positionFundingRates: [positionRate(long(), 0.0001), positionRate(short(), 0.0003)] });
  assert.equal(independent.fundingRate8h, '0.0002');
  assert.equal(independent.healthScore, 100);
  const staleAccount = metrics(undefined, { stale: true,
    positionFundingRates: [positionRate(long(), 0.0001), positionRate(short(), 0.0003)] });
  assert.equal(staleAccount.fundingRate8h, '0.0002');
  assert.equal(staleAccount.health, 'unknown');
});

test('dedicated funding time uses the older leg and settlement requires both known times', () => {
  const rates = [positionRate(long(), 0, { fundingAt: now - 50, nextFundingAt: now - 1 }),
    positionRate(short(), 0, { fundingAt: now - 200, nextFundingAt: now + 2000 })];
  const result = metrics(undefined, { positionFundingRates: rates });
  assert.equal(result.fundingAsOf, now - 200);
  assert.equal(result.nextFundingAt, now - 1);
  for (const nextFundingAt of [null, 0, NaN]) {
    assert.equal(metrics(undefined, { positionFundingRates: [rates[0], { ...rates[1], nextFundingAt }] }).nextFundingAt, null);
    assert.equal(metrics(undefined, { fundingOpportunities: [opportunity({
      short: fundingLeg(short(), 0.0003, { nextFundingAt }) })] }).nextFundingAt, null);
  }
});

test('combination returns use entry-to-mark legs, cumulative funding and current margin without closed pnl', () => {
  const group = groupPositions([long(), short()], { now, fundingOpportunities: [opportunity()] })[0], result = group.metrics;
  assert.equal(result.applicable, true);
  assert.equal(result.currency, 'USDT');
  assert.equal(result.entrySpread, '0.1');
  assert.equal(result.currentSpread, '0.08');
  assert.equal(result.spreadReturn, '4');
  assert.equal(result.spreadReturnRatio, '0.02');
  assert.equal(result.margin, '20');
  assert.equal(result.fundingFee, '0.02');
  assert.equal(result.totalReturn, '4.02');
  assert.equal(result.roi, '0.201');
  assert.equal(result.annualizedReturn, '73.365');
  assert.equal(result.realizedFundingAnnualized, '0.365');
  assert.equal(result.healthScore, 100);
  assert.equal(result.health, 'good');
  assert.equal(group.net, '0');
  assert.deepEqual(group.realized, [{ currency: 'USDT', value: '1999998' }]);
  assert.deepEqual(group.notional, [{ currency: 'USDT', value: '416' }]);
});

test('holding time uses the earliest known leg and cannot invent missing or future times', () => {
  const result = metrics();
  assert.equal(result.openedAt, now - day);
  assert.equal(result.holdingMs, day);
  for (const openedAt of [null, undefined, 0, now + 1, NaN, Infinity]) {
    const incomplete = metrics([long(), short({ openedAt })]);
    assert.equal(incomplete.openedAt, null);
    assert.equal(incomplete.holdingMs, null);
    assert.equal(incomplete.annualizedReturn, null);
    assert.equal(incomplete.realizedFundingAnnualized, null);
    assert.equal(incomplete.health, 'unknown');
    assert.ok(incomplete.healthMissing.some(reason => reason.includes('时长')));
    assert.equal(incomplete.roi, '0.201');
  }
  const justOpened = metrics([long({ openedAt: now }), short({ openedAt: now })]);
  assert.equal(justOpened.holdingMs, 0);
  assert.equal(justOpened.annualizedReturn, null);
  assert.equal(justOpened.healthScore, 100);
});

test('decimal calculations retain tiny gains and losses without float cancellation', () => {
  const quantity = '0.0000000000000000001';
  const legs = [long({ baseQuantity: quantity, entryPrice: '100.000000000000000001', markPrice: '100.000000000000000002', fundingFee: '0' }),
    short({ baseQuantity: quantity, entryPrice: '101.000000000000000002', markPrice: '101.000000000000000001', fundingFee: '0' })];
  const gain = metrics(legs);
  assert.equal(gain.spreadReturn, new Decimal('2e-37').toFixed());
  assert.ok(new Decimal(gain.roi).gt(0));
  assert.ok(new Decimal(gain.annualizedReturn).gt(0));
  const loss = metrics(legs.map(p => ({ ...p, entryPrice: p.markPrice, markPrice: p.entryPrice })));
  assert.equal(loss.spreadReturn, new Decimal('-2e-37').toFixed());
  assert.ok(new Decimal(loss.annualizedReturn).lt(0));
  const huge = metrics([long({ baseQuantity: '9007199254740993.1234567890123456789' }), short({ baseQuantity: '9007199254740993.1234567890123456789' })]);
  assert.equal(huge.spreadReturn, '18014398509481986.2469135780246913578');
});

test('health thresholds are strict above 30 percent narrowing and seven days', () => {
  const boundary = metrics([long({ openedAt: now - 7 * day }), short({ markPrice: '107' })]);
  assert.equal(boundary.spreadNarrowingRatio, '0.3');
  assert.equal(boundary.healthScore, 100);
  const spreadOnly = metrics([long(), short({ markPrice: '106.999999999999999999' })]);
  assert.equal(spreadOnly.healthScore, 70);
  assert.equal(spreadOnly.health, 'good');
  assert.deepEqual(spreadOnly.healthDeductions.map(d => d.code), ['spread_narrowing']);
  const older = metrics([long({ openedAt: now - 7 * day - 1 }), short({ markPrice: '106' })]);
  assert.equal(older.healthScore, 50);
  assert.equal(older.health, 'watch');
  const reversed = opportunity({ long: fundingLeg(short(), 0.0001), short: fundingLeg(long(), 0.0003) });
  const all = metrics([long({ openedAt: now - 8 * day }), short({ markPrice: '106' })], { fundingOpportunities: [reversed] });
  assert.equal(all.healthScore, 25);
  assert.equal(all.health, 'risk');
  assert.deepEqual(all.healthDeductions.map(d => d.points), [30, 20, 25]);
});

test('negative spreads use absolute contraction and a large crossing is not narrowing', () => {
  const narrowing = metrics([long(), short({ entryPrice: '90', markPrice: '94' })]);
  assert.equal(narrowing.entrySpread, '-0.1');
  assert.equal(narrowing.currentSpread, '-0.06');
  assert.equal(narrowing.spreadNarrowingRatio, '0.4');
  assert.equal(narrowing.healthScore, 70);
  assert.equal(narrowing.spreadReturn, '-8');
  const crossing = metrics([long(), short({ entryPrice: '90', markPrice: '120' })]);
  assert.equal(crossing.spreadNarrowingRatio, '-1');
  assert.equal(crossing.healthScore, 100);
  const zeroEntry = metrics([long(), short({ entryPrice: '100' })]);
  assert.equal(zeroEntry.spreadNarrowingRatio, null);
  assert.equal(zeroEntry.health, 'unknown');
});

test('funding normalizes each interval and reverses to actual holdings independent of trading eligibility', () => {
  const result = metrics(undefined, { fundingOpportunities: [opportunity({ eligible: false, reason: '现货充提资格待确认',
    long: fundingLeg(short(), '0.0001', { intervalHours: 4 }), short: fundingLeg(long(), '0.0003', { intervalHours: 1 }) })] });
  assert.equal(result.fundingRate8h, '-0.0022');
  assert.equal(result.expectedFundingAnnualized, '-2.409');
  assert.equal(result.healthScore, 75);
  assert.equal(result.healthDeductions[0].code, 'funding_reversal');
  const tiny = metrics(undefined, { fundingOpportunities: [opportunity({
    long: fundingLeg(long(), '0.00000000000000000011'), short: fundingLeg(short(), '0.00000000000000000012') })] });
  assert.equal(tiny.fundingRate8h, '0.00000000000000000001');
  assert.equal(tiny.expectedFundingAnnualized, '0.00000000000000001095');
});

test('funding requires exact contract, exchange and quote identities', () => {
  for (const changes of [{ symbol: 'BINANCE_FUTURE_ETH_USDT' }, { exchange: 'gate' }, { quoteCurrency: 'USDC' }]) {
    const result = metrics(undefined, { fundingOpportunities: [opportunity({ long: fundingLeg(long(), 0.0001, changes) })] });
    assert.equal(result.fundingRate8h, null);
    assert.equal(result.expectedFundingAnnualized, null);
    assert.equal(result.health, 'unknown');
    assert.equal(result.healthScore, null);
  }
});

test('expired or malformed funding evidence never produces a green health score', () => {
  const invalidRows = [opportunity({ expiresAt: now }), opportunity({ expiresAt: NaN }), opportunity({ asOf: 0 }),
    opportunity({ asOf: now + 1001 }), opportunity({ asOf: now - 300000 }),
    ...[0, NaN, now + 1001, now - 300000].map(fundingAt => opportunity({ long: fundingLeg(long(), 0.0001, { fundingAt }) })),
    ...[null, 0, -1, 169, NaN].map(intervalHours => opportunity({ short: fundingLeg(short(), 0.0003, { intervalHours }) })),
    ...[null, NaN, Infinity, ''].map(rate => opportunity({ short: fundingLeg(short(), rate) }))];
  for (const row of invalidRows) {
    const result = metrics(undefined, { fundingOpportunities: [row] });
    assert.equal(result.fundingRate8h, null);
    assert.equal(result.healthScore, null);
    assert.equal(result.health, 'unknown');
    assert.ok(result.healthMissing.length > 0);
  }
  assert.equal(metrics(undefined, { fundingOpportunities: [invalidRows[0], opportunity()] }).healthScore, 100);
});

test('next settlement preserves the earliest known timestamp without rolling an elapsed cycle', () => {
  const result = metrics(undefined, { fundingOpportunities: [opportunity({ asOf: now - 50,
    long: fundingLeg(long(), 0.0001, { nextFundingAt: now - 1, fundingAt: now - 100 }),
    short: fundingLeg(short(), 0.0003, { nextFundingAt: now + 1000, fundingAt: now - 200 }) })] });
  assert.equal(result.nextFundingAt, now - 1);
  assert.equal(result.fundingAsOf, now - 200);
  const incomplete = metrics(undefined, { fundingOpportunities: [opportunity({
    long: fundingLeg(long(), 0.0001, { nextFundingAt: null }), short: fundingLeg(short(), 0.0003, { nextFundingAt: 0 }) })] });
  assert.equal(incomplete.nextFundingAt, null);
  assert.equal(incomplete.fundingRate8h, '0.0002');
});

test('stale and partial snapshots retain visible price values but suppress health evaluation', () => {
  for (const options of [{ stale: true }, { partial: true }, { marketStale: true }]) {
    const result = metrics(undefined, options);
    assert.equal(result.entrySpread, '0.1');
    assert.equal(result.currentSpread, '0.08');
    assert.equal(result.healthScore, null);
    assert.equal(result.health, 'unknown');
    assert.ok(result.healthMissing.length > 0);
  }
  assert.equal(metrics(undefined, { marketStale: true }).fundingRate8h, null);
});

test('missing amounts stay unknown while actual zeros are preserved', () => {
  const zero = metrics([long({ fundingFee: '0' }), short({ markPrice: '110', fundingFee: '0' })]);
  assert.equal(zero.spreadReturn, '0');
  assert.equal(zero.totalReturn, '0');
  assert.equal(zero.roi, '0');
  assert.equal(zero.annualizedReturn, '0');
  assert.equal(zero.realizedFundingAnnualized, '0');
  const missingFunding = metrics([long({ fundingFee: null }), short()]);
  assert.equal(missingFunding.fundingFee, null);
  assert.equal(missingFunding.totalReturn, null);
  assert.equal(missingFunding.annualizedReturn, null);
  assert.equal(missingFunding.realizedFundingAnnualized, null);
  assert.equal(missingFunding.spreadReturn, '4');
  for (const changes of [{ margin: null }, { margin: '0' }, { margin: '-1' }, { marginCurrency: 'USDC' }]) {
    const result = metrics([long(changes), short()]);
    assert.equal(result.margin, null);
    assert.equal(result.roi, null);
    assert.equal(result.annualizedReturn, null);
    assert.equal(result.realizedFundingAnnualized, null);
  }
  for (const changes of [{ entryPrice: null }, { entryPrice: '0' }, { markPrice: null }, { markPrice: '-1' }]) {
    const result = metrics([long(changes), short()]);
    assert.equal(result.spreadReturn, null);
    assert.equal(result.spreadReturnRatio, null);
    assert.equal(result.annualizedReturn, null);
    assert.equal(result.health, 'unknown');
  }
});

test('single, ambiguous, unbalanced and mixed-currency groups keep only safe base summaries', () => {
  const unsupported = [[long()], [long(), short(), short({ id: 'third' })], [long(), short({ side: 'LONG' })],
    [long(), short({ exchange: 'binance' })], [long(), short({ side: 'UNKNOWN' })],
    [long(), short({ baseQuantity: '2.0000000000000000001' })], [long(), short({ baseQuantity: null })],
    [long(), short({ baseQuantity: '0' })], [long(), short({ quoteCurrency: 'USDC', pnlCurrency: 'USDC' })],
    [long(), short({ pnlCurrency: 'BTC' })], [long(), short({ symbol: 'OKX_SPOT_BTC_USDT' })],
    [long(), short({ symbol: 'OKX_FUTURE_BTC_USDC' })]];
  for (const legs of unsupported) {
    const result = metrics(legs);
    assert.equal(result.applicable, false);
    assert.equal(result.entrySpread, null);
    assert.equal(result.spreadReturn, null);
    assert.equal(result.health, 'unknown');
    assert.equal(result.healthScore, null);
    assert.ok(result.reasons.length > 0);
  }
  const mixed = groupPositions([long(), short({ pnlCurrency: 'USDC' })], { now })[0];
  assert.deepEqual(mixed.pnl, [{ currency: 'USDT', value: '0' }, { currency: 'USDC', value: '4' }]);
  assert.equal(mixed.net, '0');
  assert.equal(groupPositions([]).length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { actionDecimal, addFractionQuantity, addQuantityFromTotal, commonQuantityStep, estimatePositionDelta, legQuantityDiff, planPositionAction,
  positionActionInput, positionPairProblem, positionPreviewChanged, positionSnapshotChanged, sharedAvailableMargin, spreadDeviation } from '../src/position-actions.ts';

const sourceResolution = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(context.parentURL?.endsWith('/src/position-view.ts') && specifier === './live-display' ? './live-display.ts' : specifier, context);
} });
const { groupPositions } = await import('../src/position-view.ts');
sourceResolution.deregister();
const now = 1800000000000;
const position = (changes = {}) => ({ id: 'long', symbol: 'BINANCE_FUTURE_BTC_USDT', exchange: 'binance', side: 'LONG',
  quantity: '2', baseQuantity: '2', baseCurrency: 'BTC', quoteCurrency: 'USDT', pnlCurrency: 'USDT',
  entryPrice: '100', markPrice: '100', margin: '20', marginCurrency: 'USDT', leverage: '10',
  unrealizedPnl: '0', liquidationPrice: null, external: true, updatedAt: now, ...changes });
const long = (changes = {}) => position(changes);
const short = (changes = {}) => position({ id: 'short', exchange: 'okx', symbol: 'OKX_FUTURE_BTC_USDT', side: 'SHORT', ...changes });
const group = (legs = [long(), short()]) => groupPositions(legs, { now })[0];
const instruments = (changes = []) => [long(), short()].map((leg, index) => ({ symbol: leg.symbol, exchange: leg.exchange, base: 'BTC',
  quoteCurrency: 'USDT', settlementCurrency: 'USDT', lot_size: '0.01', min_size: '0.01', tick_size: '0.1', max_limit_size: '100', ...changes[index] }));
const live = (changes = {}) => ({ connection: { connected: true, version: 8, accountId: 'test-account' }, stale: false, partial: false,
  asOf: now, positions: [long(), short()], account: { account_mode: 'CROSS_EXCHANGE', available_margin: '123.456' }, ...changes });

test('only valid cross-exchange long/short base pairs can be balanced', () => {
  assert.equal(positionPairProblem([long(), short()]), null);
  for (const legs of [[long()], [long(), short(), short({ id: 'third' })], [long(), short({ side: 'LONG' })],
    [long(), short({ exchange: 'binance' })], [long(), short({ quoteCurrency: 'USDC' })], [long(), short({ baseCurrency: 'ETH' })],
    [long(), short({ baseQuantity: null })], [long(), short({ baseQuantity: '0' })], [long(), short({ id: 'long' })]]) {
    assert.ok(positionPairProblem(legs)); assert.equal(legQuantityDiff(legs).needsBalance, false);
  }
});

test('balance threshold uses mean, strict greater-than, and never makes unequal quantities eligible for add', () => {
  assert.equal(legQuantityDiff([long({ baseQuantity: '1999' }), short({ baseQuantity: '2001' })]).needsBalance, false);
  assert.equal(legQuantityDiff([long({ baseQuantity: '1998.99999999999999999' }), short({ baseQuantity: '2001' })]).needsBalance, true);
  const slightlyUnequal = group([long(), short({ baseQuantity: '2.0001' })]);
  assert.equal(legQuantityDiff(slightlyUnequal.legs).needsBalance, false);
  assert.ok(planPositionAction(slightlyUnequal, instruments(), 'add', '1').errors.length);
  assert.equal(legQuantityDiff([long(), short({ baseQuantity: '-2.000' })]).equal, true);
});

test('common step is exact LCM, not the largest exchange step', () => {
  assert.equal(commonQuantityStep(['0.02', '0.03']), '0.06');
  assert.equal(commonQuantityStep(['0.0025', '0.003']), '0.015');
  assert.equal(commonQuantityStep(['0.00000000000000000002', '0.00000000000000000003']), '0.00000000000000000006');
  assert.equal(commonQuantityStep(['0.01', '0.1']), '0.1');
  for (const steps of [[], ['0.1', null], ['0', '0.1'], ['bad', '0.1']]) assert.equal(commonQuantityStep(steps), null);
});

test('all shortcuts including 100 percent floor to the common step without floating point', () => {
  assert.equal(addFractionQuantity('1', 100, '0.06'), '0.96');
  assert.equal(addFractionQuantity('1', 25, '0.06'), '0.24');
  assert.equal(addFractionQuantity('1', 50, '0.06'), '0.48');
  assert.equal(addFractionQuantity('1', 75, '0.06'), '0.72');
  assert.equal(addFractionQuantity('0.0001', 25, '0.001'), null);
  assert.equal(addFractionQuantity('1', 100, null), null);
  assert.equal(addFractionQuantity('9007199254740993.1234567890123456789', 100, '0.0000000000000000001'), '9007199254740993.1234567890123456789');
});

test('custom total derives exact positive increment and rejects non-plain or non-increasing input', () => {
  assert.equal(addQuantityFromTotal('9007199254740993.1234567890123456789', '9007199254740993.1234567890123456788'), '0.0000000000000000001');
  for (const total of ['', '0', '2', '1', '1e4', 'Infinity', '-3']) assert.equal(addQuantityFromTotal(total, '2'), null);
});

test('add requires applicable metrics and every actual delta and target obey both legs rules', () => {
  const rules = instruments([{ lot_size: '0.02' }, { lot_size: '0.03' }]), equal = group([long({ baseQuantity: '0.6' }), short({ baseQuantity: '0.6' })]);
  assert.deepEqual(planPositionAction(equal, rules, 'add', '0.06').errors, []);
  assert.ok(planPositionAction(equal, rules, 'add', '0.03').errors.some(error => error.includes('步长')));
  assert.ok(planPositionAction({ ...equal, metrics: { ...equal.metrics, applicable: false } }, rules, 'add', '0.06').errors.length);
  assert.ok(planPositionAction(equal, instruments([{ min_size: '0.1' }]), 'add', '0.06').errors.some(error => error.includes('最小数量')));
  assert.ok(planPositionAction(equal, instruments([{ max_limit_size: '0.04' }]), 'add', '0.06').errors.some(error => error.includes('上限')));
  assert.ok(planPositionAction(equal, instruments([{ min_notional: '100' }]), 'add', '0.06').errors.some(error => error.includes('最小名义额')));
  assert.ok(planPositionAction(equal, [], 'add', '0.06').errors.some(error => error.includes('未知')));
  for (const value of ['0', '-1', '1e3', 'NaN', '']) assert.ok(planPositionAction(equal, rules, 'add', value).errors.length);
});

test('balance reduce/increase/custom generate correct directions including unchanged and mixed legs', () => {
  const unequal = group([long({ baseQuantity: '3' }), short({ baseQuantity: '2' })]);
  const reduce = planPositionAction(unequal, instruments(), 'balance', '', 'reduce');
  assert.deepEqual(reduce.legs.map(leg => [leg.quantity, leg.reduceOnly, leg.unchanged]), [['1', true, false], ['0', false, true]]);
  assert.equal(reduce.hasIncrease, false); assert.equal(reduce.targetQuantity, '2');
  const increase = planPositionAction(unequal, instruments(), 'balance', '', 'increase');
  assert.deepEqual(increase.legs.map(leg => [leg.quantity, leg.reduceOnly, leg.unchanged]), [['0', false, true], ['1', false, false]]);
  assert.equal(increase.hasIncrease, true); assert.equal(increase.targetQuantity, '3');
  const target = planPositionAction(unequal, instruments(), 'balance', '2.5', 'target');
  assert.deepEqual(target.legs.map(leg => [leg.quantity, leg.reduceOnly]), [['0.5', true], ['0.5', false]]);
  assert.equal(target.hasIncrease, true); assert.deepEqual(target.errors, []);
  assert.equal(planPositionAction(unequal, instruments(), 'balance', '1', 'target').hasIncrease, false);
  assert.equal(planPositionAction(unequal, instruments(), 'balance', '4', 'target').hasIncrease, true);
});

test('target is validated for both instruments even when a leg would remain unchanged', () => {
  const unequal = group([long({ baseQuantity: '0.08' }), short({ baseQuantity: '0.06' })]);
  const result = planPositionAction(unequal, instruments([{ lot_size: '0.04' }, { lot_size: '0.03' }]), 'balance', '', 'reduce');
  assert.ok(result.errors.some(error => error.includes('目标数量')));
});

test('requests contain both frozen quantities and directions even for a single adjusted leg', () => {
  const unequal = group([long({ baseQuantity: '-3' }), short()]);
  const plan = planPositionAction(unequal, instruments(), 'balance', '', 'reduce');
  assert.deepEqual(positionActionInput(plan, 'balance', 'reduce', 'version-8'), { kind: 'position', action: 'balance', strategy: 'reduce', connectionVersion: 'version-8',
    positions: [{ positionId: 'long', expectedQuantity: '3', expectedSide: 'LONG' }, { positionId: 'short', expectedQuantity: '2', expectedSide: 'SHORT' }] });
  const add = positionActionInput(planPositionAction(group(), instruments(), 'add', '0.1'), 'add', 'reduce', 8);
  assert.equal(add.quantity, '0.1'); assert.equal('strategy' in add, false);
  assert.throws(() => positionActionInput(planPositionAction(group(), instruments(), 'add', '0'), 'add', 'reduce', 8));
});

test('snapshot detects quantity, side, account or group composition changes while allowing mark-only refresh', () => {
  const selected = group();
  assert.equal(positionSnapshotChanged(selected, 8, 'test-account', live()), false);
  assert.equal(positionSnapshotChanged(selected, 8, 'test-account', live({ positions: [long({ markPrice: '101' }), short()] })), false);
  for (const current of [live({ positions: [long({ baseQuantity: '2.1' }), short()] }), live({ positions: [long({ side: 'SHORT' }), short()] }),
    live({ positions: [long()] }), live({ positions: [long(), short(), short({ id: 'third' })] }), live({ connection: { version: 9, accountId: 'test-account' } }),
    live({ connection: { version: 8, accountId: 'other' } })]) assert.equal(positionSnapshotChanged(selected, 8, 'test-account', current), true);
});

test('confirmation retains both-leg quantity and side checks even when only one leg has an order', () => {
  const selected = group([long({ baseQuantity: '3' }), short()]), current = live({ positions: selected.legs });
  const input = positionActionInput(planPositionAction(selected, instruments(), 'balance', '', 'reduce'), 'balance', 'reduce', 8);
  assert.equal(positionPreviewChanged(input, current), false);
  assert.equal(positionPreviewChanged(input, { ...current, positions: [selected.legs[0], short({ side: 'LONG' })] }), true);
  assert.equal(positionPreviewChanged(input, { ...current, positions: [selected.legs[0], short({ baseQuantity: '2.1' })] }), true);
  assert.equal(positionPreviewChanged(input, { ...current, connection: { version: 9 } }), true);
});

test('margin and fees use exact native currency values and preserve unknown inputs', () => {
  const plan = planPositionAction(group(), instruments(), 'add', '0.5');
  assert.deepEqual(estimatePositionDelta(plan.legs[0], '0.0005'), { notional: '50', projectedNotional: '250', marginChange: '5', fee: '0.025' });
  assert.equal(estimatePositionDelta({ ...plan.legs[0], position: long({ leverage: null }) }).marginChange, null);
  assert.equal(estimatePositionDelta({ ...plan.legs[0], position: long({ markPrice: null }) }, '0.001').fee, null);
  assert.equal(estimatePositionDelta(plan.legs[0]).fee, null);
  assert.equal(estimatePositionDelta({ ...plan.legs[0], position: long({ marginCurrency: 'BTC' }) }).marginChange, null);
  const reduce = planPositionAction(group([long({ baseQuantity: '3' }), short()]), instruments(), 'balance', '', 'reduce');
  assert.equal(estimatePositionDelta(reduce.legs[0], '0.0005').marginChange, '-10');
  assert.equal(estimatePositionDelta(reduce.legs[1]).marginChange, '0');
});

test('only fresh shared CROSS_EXCHANGE margin is displayed; isolated, absent and stale remain unknown', () => {
  assert.equal(sharedAvailableMargin(live(), now + 0.25), '123.456');
  assert.equal(sharedAvailableMargin(live({ account: { account_mode: 'CROSS_EXCHANGE', available_margin: '0' } }), now), '0');
  for (const current of [live({ stale: true }), live({ partial: true }), live({ asOf: now - 15001 }), live({ asOf: now + 1001 }),
    live({ account: { account_mode: 'ISOLATED_EXCHANGE', available_margin: '999' } }), live({ account: {} })]) assert.equal(sharedAvailableMargin(current, now), null);
});

test('spread warning measures absolute deviation and cannot divide by zero', () => {
  const selected = group();
  assert.equal(spreadDeviation({ ...selected, metrics: { entrySpread: '0.1', currentSpread: '0.06' } })?.toFixed(), '0.4');
  assert.equal(spreadDeviation({ ...selected, metrics: { entrySpread: '-0.1', currentSpread: '0.1' } })?.toFixed(), '2');
  assert.equal(spreadDeviation({ ...selected, metrics: { entrySpread: '0', currentSpread: '0.1' } }), null);
  assert.equal(spreadDeviation({ ...selected, metrics: { entrySpread: null, currentSpread: '0.1' } }), null);
});

test('recurring spread deviation stays comparable without passing through the external input limit', () => {
  const selected = group([long({ entryPrice: '100', markPrice: '100' }), short({ entryPrice: '103', markPrice: '104' })]);
  const deviation = spreadDeviation(selected);
  assert.ok(deviation.gt('0.3333') && deviation.lt('0.3334'));
  assert.equal(deviation.gt('0.3'), true);
  for (const [currentSpread, expected] of [['0.039', false], ['0.039000000000000000001', true], ['0.038999999999999999999', false]]) {
    assert.equal(spreadDeviation({ ...selected, metrics: { entrySpread: '0.03', currentSpread } }).gt('0.3'), expected);
  }
  assert.equal(actionDecimal('0.' + '1'.repeat(159)), null, 'external input length remains bounded');
});

test('a valid balance plan can estimate a calculated delta longer than the original inputs', () => {
  const selected = group([long({ baseQuantity: '1e100' }), short({ baseQuantity: '1e-100' })]);
  const rules = instruments([{}, {}].map(() => ({ lot_size: '1e-100', min_size: '1e-100', max_limit_size: null })));
  const plan = planPositionAction(selected, rules, 'balance', '', 'reduce');
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.legs[0].quantity.length > 160, true);
  const estimate = estimatePositionDelta(plan.legs[0]);
  assert.ok(estimate.marginChange.startsWith('-'));
  assert.equal(estimate.projectedNotional, '0.' + '0'.repeat(97) + '1');
});

import { AppError } from './model.mjs';
import { D, Decimal } from './money.mjs';
import { canonicalBase } from '../../../server/asset-identity.mjs';

const fail = message => { throw new AppError(message, 409); };
const exactPositive = value => typeof value === 'string' && /^\d{1,30}(?:\.\d{1,30})?$/.test(value) && D(value).gt(0);
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
export const positionKey = p => p.position_id ? String(p.position_id) : `${p.symbol}:${p.position_side}`;
export function positionDirection(position, mode) {
  if (['LONG', 'SHORT'].includes(position.position_side)) return position.position_side;
  if (mode === 'SINGLE' && position.position_side === 'NONE' && !D(position.position_qty).isZero()) return D(position.position_qty).gt(0) ? 'LONG' : 'SHORT';
  return null;
}
const groupKey = symbol => {
  const [exchange, , base, ...quote] = symbol.split('_');
  return JSON.stringify([canonicalBase(exchange.toLowerCase(), base), quote.join('_')]);
};

// Only stable position identities and expected snapshots cross the HTTP boundary.
// Symbols, directions, quantities and reduce-only flags are derived here.
export function bindPositionAction(input, cache, connectionVersion) {
  const allowed = ['kind', 'action', 'connectionVersion', 'positions', ...(input?.action === 'add' ? ['quantity'] : ['strategy', ...(input?.strategy === 'target' ? ['targetQuantity'] : [])])];
  if (!fields(input, allowed) || input.kind !== 'position' || !['add', 'balance'].includes(input.action)
    || input.action === 'add' && !exactPositive(input.quantity)
    || input.action === 'balance' && (!['reduce', 'increase', 'target'].includes(input.strategy) || input.strategy === 'target' && !exactPositive(input.targetQuantity))) {
    throw new AppError('持仓操作参数无效，请使用有效的加仓数量或平衡目标', 400);
  }
  const version = input.connectionVersion;
  if (!['number', 'string'].includes(typeof version) || !/^[1-9][0-9]*$/.test(String(version)) || !Number.isSafeInteger(Number(version)) || Number(version) !== connectionVersion) fail('账户连接已变化，请刷新后重试');
  if (!Array.isArray(input.positions) || input.positions.length !== 2
    || input.positions.some(p => !fields(p, ['positionId', 'expectedQuantity', 'expectedSide']) || typeof p.positionId !== 'string' || !p.positionId || p.positionId.length > 200
      || !exactPositive(p.expectedQuantity) || !['LONG', 'SHORT'].includes(p.expectedSide))
    || new Set(input.positions.map(p => p.positionId)).size !== 2) throw new AppError('请选择两个不同的真实持仓并提供当前数量和方向', 400);
  const held = cache.positions.filter(p => !D(p.position_qty).isZero());
  const positions = input.positions.map(selection => {
    const matches = held.filter(p => positionKey(p) === selection.positionId);
    if (matches.length !== 1) fail('实际持仓不存在、重复或已平仓');
    const p = matches[0], positionSide = positionDirection(p, cache.account.position_mode);
    if (!positionSide) fail('持仓方向无法核实，暂不能调整');
    if (positionSide !== selection.expectedSide || !D(p.position_qty).abs().eq(selection.expectedQuantity)) fail('持仓数量或方向已变化，请刷新后重试');
    return { positionId: selection.positionId, symbol: p.symbol, positionSide, heldQuantity: D(p.position_qty).abs().toString(),
      directionSource: ['LONG', 'SHORT'].includes(p.position_side) ? 'exchange' : 'quantity_sign' };
  });
  if (new Set(positions.map(p => p.positionSide)).size !== 2 || new Set(positions.map(p => p.symbol.split('_')[0])).size !== 2
    || new Set(positions.map(p => groupKey(p.symbol))).size !== 1) fail('持仓组合须为同一资产及计价币、不同交易所的一多一空');
  if (held.filter(p => groupKey(p.symbol) === groupKey(positions[0].symbol)).length !== 2) fail('此资产组合包含额外持仓，不能按双腿调整');
  const [first, second] = positions.map(p => D(p.heldQuantity)), equal = first.eq(second);
  let target;
  if (input.action === 'add') {
    if (!equal) fail('双腿数量不相等，请先平衡后再加仓');
    target = first.plus(input.quantity);
  } else {
    if (first.minus(second).abs().div(first.plus(second).div(2)).lte('0.001')) fail('双腿数量差异未超过 0.1%，无需平衡');
    target = input.strategy === 'reduce' ? Decimal.min(first, second) : input.strategy === 'increase' ? Decimal.max(first, second) : D(input.targetQuantity);
  }
  return { positions: positions.map(p => ({ ...p, quantity: target.minus(p.heldQuantity).abs().toString(), targetQuantity: target.toString() })), targetQuantity: target.toString() };
}

export function validatePositionLegs(plan, bindings, mode) {
  const expected = bindings.positions.filter(p => !D(p.quantity).isZero()).toSorted((a, b) => Number(D(b.heldQuantity).gt(b.targetQuantity)) - Number(D(a.heldQuantity).gt(a.targetQuantity)));
  if (plan.kind !== 'position' || !Array.isArray(plan.legs) || plan.legs.length !== expected.length) fail('持仓调整计划不完整');
  for (const [index, p] of expected.entries()) {
    const leg = plan.legs[index], reduceOnly = D(p.targetQuantity).lt(p.heldQuantity);
    const side = (p.positionSide === 'LONG') !== reduceOnly ? 'BUY' : 'SELL';
    if (leg.positionId !== p.positionId || leg.symbol !== p.symbol || leg.side !== side || leg.reduceOnly !== reduceOnly
      || leg.positionSide !== (mode === 'SINGLE' ? 'NONE' : p.positionSide) || !D(leg.quantity).eq(p.quantity)
      || leg.orderType !== 'LIMIT' || leg.timeInForce !== 'IOC') fail('持仓调整计划与实际持仓不匹配');
  }
}

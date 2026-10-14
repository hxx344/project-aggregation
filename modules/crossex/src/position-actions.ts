import Decimal from 'decimal.js';
import type { Instrument, LivePosition, LiveView, PositionActionInput } from './live-types';
import type { PositionGroup } from './position-view';

const D = Decimal.clone({ precision: 200 });
export type BalanceStrategy = 'reduce' | 'increase' | 'target';
export function actionDecimal(value: unknown): Decimal | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 160) return null;
  try { const n = new D(value); return n.isFinite() && n.e <= 100 && n.e >= -100 ? n : null; } catch { return null; }
}
function positive(value: unknown) { const n = actionDecimal(value); return n?.gt(0) ? n : null; }
function inputQuantity(value: string) { return /^\d+(?:\.\d+)?$/.test(value) ? positive(value) : null; }

export function positionPairProblem(legs: LivePosition[]): string | null {
  if (legs.length !== 2 || legs[0].id === legs[1].id) return '需要恰好两条不同的持仓腿';
  if (!legs.some(p => p.side.toUpperCase() === 'LONG') || !legs.some(p => p.side.toUpperCase() === 'SHORT')) return '需要一条多仓和一条空仓';
  if (!legs[0].exchange || !legs[1].exchange || legs[0].exchange === legs[1].exchange) return '双腿需要来自不同交易所';
  if (!legs[0].baseCurrency || legs[0].baseCurrency !== legs[1].baseCurrency) return '双腿基础币不同或缺失';
  if (!legs[0].quoteCurrency || legs[0].quoteCurrency !== legs[1].quoteCurrency) return '双腿计价币不同或缺失';
  if (legs.some(p => !positive(actionDecimal(p.baseQuantity)?.abs().toFixed()))) return '持仓基础币数量缺失或无效';
  return null;
}

export function legQuantityDiff(legs: LivePosition[]) {
  const problem = positionPairProblem(legs);
  if (problem) return { problem, larger: null, smaller: null, diff: null, ratio: null, equal: false, needsBalance: false };
  const a = actionDecimal(legs[0].baseQuantity)!.abs(), b = actionDecimal(legs[1].baseQuantity)!.abs();
  const diff = a.sub(b).abs(), mean = a.add(b).div(2);
  return { problem: null, larger: a.gte(b) ? legs[0] : legs[1], smaller: a.gte(b) ? legs[1] : legs[0],
    diff: diff.toFixed(), ratio: diff.div(mean).toFixed(), equal: diff.isZero(), needsBalance: diff.gt(mean.mul('0.001')) };
}

/** Common quantities must be divisible by both steps, including non-power-of-ten steps. */
export function commonQuantityStep(steps: (string | null | undefined)[]): string | null {
  if (!steps.length) return null;
  const parsed = steps.map(positive);
  if (parsed.some(step => !step)) return null;
  const places = Math.max(...parsed.map(step => step!.decimalPlaces()));
  if (places > 100) return null;
  const scale = new D(10).pow(places), units = parsed.map(step => BigInt(step!.mul(scale).toFixed(0)));
  const gcd = (a: bigint, b: bigint): bigint => { while (b) { const remainder = a % b; a = b; b = remainder; } return a; };
  const multiple = units.reduce((a, b) => a / gcd(a, b) * b);
  return new D(multiple.toString()).div(scale).toFixed();
}

export function addFractionQuantity(held: string | null, percent: number, step: string | null): string | null {
  const amount = actionDecimal(held)?.abs(), increment = positive(step);
  if (!amount?.gt(0) || !increment || ![25, 50, 75, 100].includes(percent)) return null;
  const result = amount.mul(percent).div(100).div(increment).floor().mul(increment);
  return result.gt(0) ? result.toFixed() : null;
}

export function addQuantityFromTotal(total: string, held: string | null): string | null {
  const target = inputQuantity(total), current = actionDecimal(held)?.abs();
  return target && current && target.gt(current) ? target.sub(current).toFixed() : null;
}

export function positionInstrument(position: LivePosition, instruments: Instrument[]) {
  return instruments.find(i => i.symbol === position.symbol && i.exchange === position.exchange);
}

export type PositionDelta = { position: LivePosition; heldQuantity: string; targetQuantity: string; quantity: string; reduceOnly: boolean; unchanged: boolean };
export type PositionActionPlan = { targetQuantity: string | null; quantity: string | null; legs: PositionDelta[]; errors: string[]; hasIncrease: boolean };
export function planPositionAction(group: PositionGroup, instruments: Instrument[], action: 'add' | 'balance', value: string, strategy: BalanceStrategy = 'reduce'): PositionActionPlan {
  const diff = legQuantityDiff(group.legs), errors: string[] = [];
  const empty = (): PositionActionPlan => ({ targetQuantity: null, quantity: null, legs: [], errors, hasIncrease: action === 'add' || strategy === 'increase' });
  if (diff.problem) { errors.push(diff.problem); return empty(); }
  if (action === 'add' && (!diff.equal || !group.metrics.applicable)) { errors.push('加仓需要严格等量且有效的双腿组合'); return empty(); }
  if (action === 'balance' && !diff.needsBalance) { errors.push('数量差异未超过双腿均值的 0.1%，无需平衡'); return empty(); }
  const held = actionDecimal(group.legs[0].baseQuantity)!.abs();
  let target: Decimal | null, quantity: Decimal | null = null;
  if (action === 'add') { quantity = inputQuantity(value); target = quantity ? held.add(quantity) : null; }
  else target = strategy === 'reduce' ? actionDecimal(diff.smaller!.baseQuantity)!.abs()
    : strategy === 'increase' ? actionDecimal(diff.larger!.baseQuantity)!.abs() : inputQuantity(value);
  if (!target?.gt(0)) { errors.push(action === 'add' ? '请输入大于 0 的加仓数量' : '请输入大于 0 的目标数量'); return empty(); }
  const legs = group.legs.map(position => {
    const current = actionDecimal(position.baseQuantity)!.abs(), delta = target!.sub(current), amount = delta.abs();
    const leg: PositionDelta = { position, heldQuantity: current.toFixed(), targetQuantity: target!.toFixed(), quantity: amount.toFixed(), reduceOnly: delta.lt(0), unchanged: delta.isZero() };
    const rule = positionInstrument(position, instruments), step = positive(rule?.lot_size), minimum = positive(rule?.min_size);
    if (step && !target!.mod(step).isZero()) errors.push(`${position.symbol} 目标数量必须是步长 ${step.toFixed()} 的整数倍`);
    if (!rule || !step || !minimum) errors.push(`${position.symbol} 数量规则未知，等待合约目录`);
    else if (!leg.unchanged) {
      if (!amount.mod(step).isZero()) errors.push(`${position.symbol} 调整数量必须是步长 ${step.toFixed()} 的整数倍`);
      if (amount.lt(minimum)) errors.push(`${position.symbol} 调整数量小于最小数量 ${minimum.toFixed()}`);
      const maximum = positive(rule.max_limit_size);
      if (maximum && amount.gt(maximum)) errors.push(`${position.symbol} 调整数量超过单笔限价上限 ${maximum.toFixed()}`);
      const minimumNotional = positive(rule.min_notional), mark = positive(position.markPrice);
      if (minimumNotional && mark && amount.mul(mark).lt(minimumNotional)) errors.push(`${position.symbol} 按标记价估算低于最小名义额 ${minimumNotional.toFixed()} ${position.quoteCurrency}`);
    }
    return leg;
  });
  return { targetQuantity: target.toFixed(), quantity: quantity?.toFixed() ?? null, legs, errors, hasIncrease: legs.some(leg => !leg.unchanged && !leg.reduceOnly) };
}

export function positionActionInput(plan: PositionActionPlan, action: 'add' | 'balance', strategy: BalanceStrategy, connectionVersion: string | number): PositionActionInput {
  if (plan.errors.length || plan.legs.length !== 2 || !plan.targetQuantity) throw new Error('持仓操作尚未通过数量校验');
  return { kind: 'position', action, connectionVersion, positions: plan.legs.map(leg => ({ positionId: leg.position.id, expectedQuantity: leg.heldQuantity,
    expectedSide: leg.position.side.toUpperCase() as 'LONG' | 'SHORT' })),
    ...(action === 'add' ? { quantity: plan.quantity! } : { strategy, ...(strategy === 'target' ? { targetQuantity: plan.targetQuantity } : {}) }) };
}

/** Price updates are harmless; quantity, direction, identity or account changes invalidate the frozen intent. */
export function positionSnapshotChanged(group: PositionGroup, version: string | number, accountId: string | null, live: LiveView): boolean {
  if (version !== live.connection.version || accountId !== live.connection.accountId) return true;
  const current = live.positions.filter(p => p.baseCurrency === group.base || group.legs.some(old => old.id === p.id));
  return current.length !== group.legs.length || group.legs.some(old => {
    const next = current.find(p => p.id === old.id), previousQuantity = actionDecimal(old.baseQuantity)?.abs(), nextQuantity = actionDecimal(next?.baseQuantity)?.abs();
    return !next || !previousQuantity || !nextQuantity || !previousQuantity.eq(nextQuantity) || old.side.toUpperCase() !== next.side.toUpperCase()
      || old.symbol !== next.symbol || old.exchange !== next.exchange || old.baseCurrency !== next.baseCurrency || old.quoteCurrency !== next.quoteCurrency;
  });
}

export function positionPreviewChanged(input: PositionActionInput, live: LiveView): boolean {
  if (input.connectionVersion !== live.connection.version || input.positions.length !== 2) return true;
  const positions = input.positions.map(expected => live.positions.find(p => p.id === expected.positionId));
  if (positions.some(position => !position)) return true;
  const base = positions[0]!.baseCurrency;
  if (!base || positions[1]!.baseCurrency !== base || live.positions.filter(p => p.baseCurrency === base).length !== 2) return true;
  return input.positions.some((expected, index) => {
    const current = positions[index]!, quantity = actionDecimal(current.baseQuantity)?.abs();
    return !quantity || !quantity.eq(expected.expectedQuantity) || current.side.toUpperCase() !== expected.expectedSide;
  });
}

export function estimatePositionDelta(leg: PositionDelta, takerRate: string | null = null) {
  // The plan already validated the inputs. Its calculated delta can be longer than either input.
  const mark = positive(leg.position.markPrice), leverage = positive(leg.position.leverage), quantity = new D(leg.quantity);
  const linear = leg.position.quoteCurrency === leg.position.pnlCurrency && ['USDT', 'USDC', 'USD'].includes(leg.position.quoteCurrency);
  const notional = linear && mark ? quantity.mul(mark) : null;
  const margin = notional && leverage && leg.position.marginCurrency === leg.position.quoteCurrency ? notional.div(leverage) : null;
  const rate = actionDecimal(takerRate);
  return { notional: notional?.toFixed() ?? null,
    projectedNotional: linear && mark ? new D(leg.targetQuantity).mul(mark).toFixed() : null,
    marginChange: leg.unchanged ? '0' : margin?.mul(leg.reduceOnly ? -1 : 1).toFixed() ?? null,
    fee: leg.unchanged ? '0' : notional && rate ? notional.mul(rate).toFixed() : null };
}

export function sharedAvailableMargin(live: LiveView, now: number): string | null {
  if (live.stale || live.partial || !live.connection.connected || !live.asOf || !Number.isFinite(now) || now - live.asOf > 15_000 || live.asOf > now + 1000
    || live.account?.account_mode !== 'CROSS_EXCHANGE') return null;
  return actionDecimal(live.account.available_margin)?.toFixed() ?? null;
}

export function spreadDeviation(group: PositionGroup): Decimal | null {
  const entry = actionDecimal(group.metrics.entrySpread), current = actionDecimal(group.metrics.currentSpread);
  return entry && !entry.isZero() && current ? current.sub(entry).abs().div(entry.abs()) : null;
}

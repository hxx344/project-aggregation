import { AppError } from './model.mjs';
import { D, Decimal } from './money.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const symbolPattern = /^(BINANCE|BYBIT|OKX|GATE|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]{1,30}_(USDT|USDC|USD)$/;
const invalid = () => { throw new AppError('开仓容量的合约、方向、类型、数量或价格无效'); };
const optionalDecimal = value => {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || !/^\d{1,30}(?:\.\d{1,30})?$/.test(value) || !D(value).gt(0)) invalid();
  return D(value).toString();
};

// Validate before public identity reads or private requests. This request has no
// execution kind, preview id or settings fields and never authorizes a write.
export function capacityRequest(input) {
  if (!object(input) || Object.keys(input).some(k => !['order', 'pair'].includes(k)) || [input.order, input.pair].filter(v => v !== undefined).length !== 1) invalid();
  const source = input.order !== undefined ? 'direct' : 'pair', value = input.order ?? input.pair;
  const fields = source === 'direct' ? ['symbol', 'side', 'quantity', 'orderType', 'price', 'timeInForce'] : ['longSymbol', 'shortSymbol', 'quantity'];
  if (!object(value) || Object.keys(value).some(k => !fields.includes(k))) invalid();
  const quantity = optionalDecimal(value.quantity);
  let requests;
  if (source === 'direct') {
    if (!['BUY', 'SELL'].includes(value.side) || !['LIMIT', 'MARKET'].includes(value.orderType) || !['GTC', 'IOC', 'FOK', 'POC'].includes(value.timeInForce)
      || value.orderType === 'MARKET' && (!['IOC', 'FOK'].includes(value.timeInForce) || value.price !== undefined)) invalid();
    const price = optionalDecimal(value.price);
    requests = [{ symbol: value.symbol, side: value.side, orderType: value.orderType, timeInForce: value.timeInForce, ...(price === null ? {} : { price }) }];
  } else requests = [{ symbol: value.longSymbol, side: 'BUY', orderType: 'LIMIT', timeInForce: 'IOC' },
    { symbol: value.shortSymbol, side: 'SELL', orderType: 'LIMIT', timeInForce: 'IOC' }];
  if (requests.some(r => typeof r.symbol !== 'string' || r.symbol.length > 100 || !symbolPattern.test(r.symbol))) invalid();
  return { source, quantity, requests };
}

export function capacityResult(request, now, connectionVersion, status = 'unavailable', reason = null) {
  return { status, reason, asOf: now, expiresAt: now, connectionVersion, base: request.requests[0].symbol.split('_')[2],
    maxQuantity: status === 'blocked' ? '0' : null, maxNotionalUSDT: status === 'blocked' ? '0' : null, requiredMargin: null,
    marginCurrency: 'USDT', reserveFactor: '1.10', inputWithinCapacity: status === 'blocked' && request.quantity !== null ? false : null,
    limitingFactors: reason ? [reason] : [], notes: [], legs: request.requests.map(r => ({ symbol: r.symbol, side: r.side,
      quoteCurrency: r.symbol.split('_').at(-1), leverage: null, maxLeverage: null,
      maxQuantity: status === 'blocked' ? '0' : null, maxNotionalUSDT: status === 'blocked' ? '0' : null,
      notionalUSDT: null, requiredMargin: null, availableMargin: null })) };
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
function quantityStep(legs) {
  const decimals = Math.max(...legs.map(l => D(l.rule.lot_size).decimalPlaces()));
  if (decimals > 30) throw new Error('UNSUPPORTED_QUANTITY_STEP');
  const scale = D(10).pow(decimals), steps = legs.map(l => BigInt(D(l.rule.lot_size).times(scale).toFixed(0)));
  if (steps.some(s => s <= 0n || s.toString().length > 64)) throw new Error('INVALID_QUANTITY_STEP');
  const common = steps.reduce((a, b) => a / gcd(a, b) * b);
  if (common.toString().length > 64) throw new Error('UNSUPPORTED_QUANTITY_STEP');
  return D(common.toString()).div(scale);
}
function riskTiers(values) {
  if (!Array.isArray(values) || !values.length || values.length > 1000) throw new Error('RISK_TIERS_UNKNOWN');
  const tiers = values.map(t => ({ min: D(t.min_risk_limit_value), max: D(t.max_risk_limit_value), leverage: D(t.leverage_max) }))
    .sort((a, b) => a.min.cmp(b.min) || a.max.cmp(b.max));
  if (!tiers[0].min.isZero() || tiers.some((t, i) => t.min.lt(0) || t.max.lte(t.min) || t.leverage.lte(0)
    || i && (t.min.gt(tiers[i - 1].max) || t.max.lte(tiers[i - 1].max) || t.leverage.gt(tiers[i - 1].leverage)))) throw new Error('RISK_TIERS_INCOMPLETE');
  return tiers;
}

/** Pure Decimal calculation. Values from an incomplete read never become zero. */
export function calculateCapacity(request, context, risk, { now, connectionVersion, positionsNotional, expiresAt }) {
  const result = capacityResult(request, now, connectionVersion), caps = [], marginGroups = new Map();
  const addCap = (value, label) => caps.push({ value: Decimal.max(0, value), label });
  const legs = context.legs.map(leg => {
    const values = risk.find(r => r.symbol === leg.symbol);
    if (!values) throw new Error('RISK_SYMBOL_UNKNOWN');
    const leverage = D(values.leverage), available = D(values.availableMargin), tiers = riskTiers(values.tiers);
    if (leverage.lte(0)) throw new Error('LEVERAGE_OR_MARGIN_UNKNOWN');
    const price = D(leg.budgetPrice), perUnit = price.times(leg.fxRate), perUnitMargin = perUnit.div(leverage).times('1.10');
    const allowed = tiers.filter(t => t.leverage.gte(leverage));
    const riskMaximum = allowed.length ? Decimal.max(...allowed.map(t => t.max)) : D(0);
    addCap(D(context.config.notionalPerLeg).div(perUnit), `${leg.symbol} 单腿预算`);
    addCap(riskMaximum.div(price), `${leg.symbol} 当前杠杆风险档位`);
    const maximum = leg.orderType === 'MARKET' ? leg.rule.max_market_size : leg.rule.max_limit_size;
    if (maximum !== null && maximum !== undefined) addCap(D(maximum), `${leg.symbol} 单笔数量上限`);
    if (leg.depthQuantity !== null) addCap(D(leg.depthQuantity), `${leg.symbol} 保护价内深度`);
    const group = marginGroups.get(values.marginGroup);
    if (group && !group.available.eq(available)) throw new Error('MARGIN_SNAPSHOT_MISMATCH');
    marginGroups.set(values.marginGroup, { available, denominator: (group?.denominator || D(0)).plus(perUnitMargin) });
    const nativeNotional = request.quantity === null ? null : D(request.quantity).times(price);
    const matching = nativeNotional === null ? [] : tiers.filter(t => nativeNotional.gte(t.min) && nativeNotional.lte(t.max));
    return { ...leg, leverage, available, perUnit, perUnitMargin,
      maxLeverage: matching.length ? Decimal.min(...matching.map(t => t.leverage)).toString() : null };
  });
  const totalPerUnit = legs.reduce((total, leg) => total.plus(leg.perUnit), D(0));
  addCap(D(context.config.maxTotalNotional).minus(positionsNotional).div(totalPerUnit), '账户总名义额');
  for (const [group, values] of marginGroups) addCap(values.available.div(values.denominator), group === 'CROSSEX' ? '共享可用保证金' : `${group} 隔离可用保证金`);
  const step = quantityStep(legs), rawMaximum = Decimal.min(...caps.map(c => c.value));
  let maximum = rawMaximum.div(step).floor().times(step);
  const minimumSatisfied = quantity => quantity.gt(0) && legs.every(l => quantity.gte(l.rule.min_size)
    && (l.rule.min_notional === null || quantity.times(l.price).gte(l.rule.min_notional)));
  const minimumBlocked = !minimumSatisfied(maximum);
  if (minimumBlocked) maximum = D(0);
  result.status = maximum.gt(0) ? 'ready' : 'blocked';
  result.reason = maximum.gt(0) ? null : minimumBlocked && rawMaximum.gt(0) ? '可开数量不足合约最小数量或最小名义额' : '当前开仓额度或可用保证金不足';
  result.maxQuantity = maximum.toString(); result.maxNotionalUSDT = maximum.times(totalPerUnit).toString();
  result.expiresAt = Math.min(context.expiresAt, expiresAt); result.asOf = Math.min(context.sourceAt, ...risk.map(r => r.asOf));
  result.limitingFactors = caps.filter(c => maximum.plus(step).gt(c.value)).map(c => c.label);
  if (minimumBlocked) result.limitingFactors.push('合约最小数量或最小名义额');
  result.notes = [...context.notes];
  result.legs = legs.map(l => ({ symbol: l.symbol, side: l.side, quoteCurrency: l.quoteCurrency,
    leverage: l.leverage.toString(), maxLeverage: l.maxLeverage, maxQuantity: maximum.toString(), maxNotionalUSDT: maximum.times(l.perUnit).toString(),
    notionalUSDT: request.quantity === null ? null : D(request.quantity).times(l.perUnit).toString(),
    requiredMargin: request.quantity === null ? null : D(request.quantity).times(l.perUnitMargin).toString(), availableMargin: l.available.toString() }));
  if (request.quantity !== null) {
    const quantity = D(request.quantity);
    result.requiredMargin = result.legs.reduce((total, leg) => total.plus(leg.requiredMargin), D(0)).toString();
    result.inputWithinCapacity = minimumSatisfied(quantity) && quantity.lte(maximum) && quantity.mod(step).isZero();
  }
  return result;
}

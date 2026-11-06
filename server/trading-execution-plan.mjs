import { decimal, addDecimals, compareDecimals } from './trading-decimal.mjs';
import { EXECUTION_EXCHANGES as VENUES, TRADING_NAMES, EXECUTION_MARKETS, EXECUTION_ALL_SYMBOLS, venueSupports } from './trading-markets.mjs';

const SCALE = 10n ** 18n;
export const EXECUTION_EXCHANGES = VENUES;
export const EXECUTION_SYMBOLS = EXECUTION_ALL_SYMBOLS;
// Oil legs hedge equal barrels; SK hynix ADR/ordinary legs hedge equal USDT
// notional; Anthropic legs hedge equal estimated shares.
export const EQUAL_SIZE_UNITS = Object.freeze({ oil: '桶', hynix: 'USDT', anthropic: '股' });
/**
 * Anthropic shares one native unit stands for, under the caller's share-count
 * assumptions (billions). Binance quotes valuation per 1B reference shares,
 * OKX per 10B (rebased 2026-06-30), Entropy io per 1B fully diluted shares
 * after the IPO (its documented conversion), trade.xyz one Class A share.
 * These are assumptions about a future listing, not venue guarantees.
 */
const SHARE_BASIS = Object.freeze({ 'binance:ANTHROPICUSDT': ['outstanding', '1'], 'okx:ANTHROPICUSDT': ['outstanding', '10'], 'hyperliquid:io:ANTH': ['diluted', '1'], 'hyperliquid:xyz:ANT': [null, '1'] });
export const SHARE_LIMITS = Object.freeze({ min: '1', max: '100' });
export function sharesPerUnit(leg, shares, contractSize = '1') {
  const basis = SHARE_BASIS[`${leg.exchange}:${leg.symbol}`];
  if (!basis || !shares) throw new ExecutionError(400, '该合约缺少股数换算假设');
  const [field, divisor] = basis, base = field ? units(shares[field]) : SCALE;
  return fromUnits(base * units(contractSize) / units(divisor));
}
function normalizeShares(value) {
  exactKeys(value, ['outstanding', 'diluted']);
  const outstanding = positive(value.outstanding, '流通股数'), diluted = positive(value.diluted, '完全稀释股数');
  for (const item of [outstanding, diluted]) if (compareDecimals(item, SHARE_LIMITS.min) < 0 || compareDecimals(item, SHARE_LIMITS.max) > 0) throw new ExecutionError(400, `股数假设须在 ${SHARE_LIMITS.min} 至 ${SHARE_LIMITS.max} 十亿股之间`);
  if (compareDecimals(diluted, outstanding) < 0) throw new ExecutionError(400, '完全稀释股数不能小于流通股数');
  return { outstanding, diluted };
}
export const MAX_BATCHES = 200;
export const QUOTE_MAX_AGE = 10_000;
/** Per-leg order type: 'chase' posts passively and follows the book; 'market' takes liquidity once. */
export const ORDER_TYPES = Object.freeze(['chase', 'market']);
export const legOrderType = leg => leg.orderType ?? 'chase';

export class ExecutionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// A refusal before anything is sent that clears once another job or position ends.
export class WaitError extends ExecutionError {}
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function exactKeys(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new ExecutionError(400, '交易参数包含不支持的字段');
}
export function positive(value, name = '数量') {
  try {
    if (typeof value !== 'string' || value.length > 48) throw new Error();
    return decimal(value, { positive: true });
  } catch { throw new ExecutionError(400, `${name}必须为正的十进制数值`); }
}
export function units(value) {
  const normalized = decimal(value), negative = normalized.startsWith('-');
  const [integer, fraction = ''] = (negative ? normalized.slice(1) : normalized).split('.');
  const result = BigInt(integer) * SCALE + BigInt(fraction.padEnd(18, '0'));
  return negative ? -result : result;
}
export function fromUnits(value) {
  const sign = value < 0n ? '-' : '', magnitude = value < 0n ? -value : value;
  const fraction = String(magnitude % SCALE).padStart(18, '0').replace(/0+$/, '');
  return sign + String(magnitude / SCALE) + (fraction ? '.' + fraction : '');
}
export const subtract = (left, right) => fromUnits(units(left) - units(right));
export const notional = (quantity, price, contractSize = '1') => fromUnits(units(quantity) * units(price) * units(contractSize) / (SCALE * SCALE));
export const isMultiple = (value, step) => units(step) > 0n && units(value) % units(step) === 0n;
const compareNotional = (quantity, price, bound, contractSize = '1') => units(quantity) * units(price) * units(contractSize) - units(bound) * SCALE * SCALE;
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ExecutionError(400, `${name}须在 ${min} 至 ${max} 之间`);
  return value;
}
export const legId = leg => `${leg.exchange}:${leg.symbol}:${leg.side}`;
export const orderSide = (action, side) => (action === 'open') === (side === 'long') ? 'buy' : 'sell';
export const positionSide = leg => leg.positionMode === 'one-way' ? 'BOTH' : leg.side === 'long' ? 'LONG' : 'SHORT';

export function normalizeIntent(body) {
  exactKeys(body, ['market', 'preset', 'action', 'legs', 'equalSize', 'shares', 'batchCount', 'batchIntervalMs', 'repriceIntervalMs', 'timeoutMs']);
  // Requests from before the market selector are oil-only.
  const market = body.market ?? 'oil';
  // hasOwn coerces its key, so an array like ['oil'] would pass without the type check.
  if (typeof market !== 'string' || !Object.hasOwn(EXECUTION_MARKETS, market)) throw new ExecutionError(400, '请选择支持的交易品种');
  const symbols = EXECUTION_MARKETS[market].symbols, anthropic = market === 'anthropic';
  if (!['four-leg', 'same-exchange', 'cross-exchange'].includes(body.preset) || !['open', 'close'].includes(body.action)) throw new ExecutionError(400, '请选择支持的交易预设与开平仓操作');
  if (anthropic && body.preset === 'four-leg') throw new ExecutionError(400, 'Anthropic 只支持两腿组合');
  if (anthropic === (body.shares === undefined)) throw new ExecutionError(400, anthropic ? '请填写流通股与完全稀释股数假设' : '该品种不使用股数假设');
  const shares = anthropic ? normalizeShares(body.shares) : null;
  if (!Array.isArray(body.legs) || body.legs.length !== (body.preset === 'four-leg' ? 4 : 2)) throw new ExecutionError(400, '交易腿数与所选预设不一致');
  const equalSize = body.equalSize === undefined ? null : positive(body.equalSize, market === 'oil' ? '每腿桶数' : anthropic ? '每腿股数' : '每腿名义金额');
  const identities = new Set();
  const legs = body.legs.map(value => {
    exactKeys(value, ['exchange', 'symbol', 'side', 'quantity', 'orderType', 'stopPrice']);
    if (!EXECUTION_EXCHANGES.includes(value.exchange) || !symbols.includes(value.symbol) || !venueSupports(value.exchange, value.symbol) || !['long', 'short'].includes(value.side)) throw new ExecutionError(400, '合约、交易所或仓位方向无效');
    const identity = `${value.exchange}:${value.symbol}`;
    if (identities.has(identity)) throw new ExecutionError(400, '同一交易所合约不能重复加入本次交易');
    identities.add(identity);
    if ((equalSize === null) === (value.quantity === undefined)) throw new ExecutionError(400, equalSize === null ? '请填写每腿数量' : '统一数量与逐腿数量只能选择一种');
    // Requests from before the order-type selector are chase orders with a required limit.
    const orderType = value.orderType ?? 'chase';
    if (!ORDER_TYPES.includes(orderType)) throw new ExecutionError(400, '下单方式只能是追价限价或市价');
    const unset = value.stopPrice === undefined || value.stopPrice === null;
    if (orderType === 'market' && !unset) throw new ExecutionError(400, '市价单不设追价界限');
    return { exchange: value.exchange, symbol: value.symbol, side: value.side, quantity: equalSize === null ? positive(value.quantity) : null, orderType, stopPrice: unset ? null : positive(value.stopPrice, '追价界限') };
  }).sort((a, b) => legId(a).localeCompare(legId(b)));
  if (body.preset === 'four-leg') {
    const exchanges = [...new Set(legs.map(leg => leg.exchange))];
    if (exchanges.length !== 2) throw new ExecutionError(400, '四腿预设需要选择两个不同的交易所');
    for (const exchange of exchanges) {
      const pair = legs.filter(leg => leg.exchange === exchange);
      if (pair.length !== 2 || pair[0].side === pair[1].side) throw new ExecutionError(400, `四腿预设要求每所 ${symbols.join(' / ')} 方向相反`);
    }
    for (const symbol of symbols) if (new Set(legs.filter(leg => leg.symbol === symbol).map(leg => leg.side)).size !== 2) throw new ExecutionError(400, '四腿预设要求同品种跨所方向相反');
  } else {
    const [a, b] = legs;
    // Anthropic venues list differently named contracts for the same company, so a cross-venue pair may differ in symbol.
    if (a.side === b.side || (body.preset === 'same-exchange' ? a.exchange !== b.exchange || a.symbol === b.symbol : a.exchange === b.exchange || !anthropic && a.symbol !== b.symbol)) throw new ExecutionError(400, '双腿方向或合约组合与预设不一致');
  }
  return { market, preset: body.preset, action: body.action, legs, equalSize, ...(shares ? { shares } : {}),
    batchCount: integer(body.batchCount, 1, MAX_BATCHES, '批次数'),
    batchIntervalMs: integer(body.batchIntervalMs, 0, 600_000, '批次间隔毫秒数'),
    repriceIntervalMs: integer(body.repriceIntervalMs, 1000, 60_000, '本地追价间隔毫秒数'),
    timeoutMs: integer(body.timeoutMs, 30_000, 3_600_000, '最长执行毫秒数') };
}

export function normalizeMarket(value, symbol, now) {
  if (!object(value) || value.symbol !== symbol || !object(value.rule)) throw new ExecutionError(502, '交易所未返回完整盘口与下单规则');
  const at = Date.parse(value.at);
  if (!Number.isFinite(at) || now - at > QUOTE_MAX_AGE || at - now > 1000) throw new ExecutionError(409, '盘口已过期，等待新行情后重试');
  const bid = positive(value.bid, '买一价'), ask = positive(value.ask, '卖一价');
  if (compareDecimals(bid, ask) >= 0) throw new ExecutionError(502, '交易所盘口交叉，暂不下单');
  const rule = {};
  for (const field of ['tickSize', 'quantityStep', 'minQuantity', 'maxQuantity']) rule[field] = positive(value.rule[field], '合约规则');
  if (value.rule.contractSize !== undefined) rule.contractSize = positive(value.rule.contractSize, '每张合约乘数');
  if (value.rule.instrumentId !== undefined) {
    if (typeof value.rule.instrumentId !== 'string' || !/^[A-Z0-9-]{1,64}$/.test(value.rule.instrumentId)) throw new ExecutionError(502, '合约代码无效');
    rule.instrumentId = value.rule.instrumentId;
  }
  if (value.rule.quantityUnit === '张') rule.quantityUnit = '张';
  if (value.rule.assetId !== undefined) {
    if (!Number.isSafeInteger(value.rule.assetId) || value.rule.assetId < 0) throw new ExecutionError(502, '合约编号无效');
    rule.assetId = value.rule.assetId;
  }
  if (value.rule.quoteAsset === 'USDC') rule.quoteAsset = 'USDC';
  // null: the venue does not offer market orders for this contract.
  rule.maxMarketQuantity = value.rule.maxMarketQuantity === undefined || value.rule.maxMarketQuantity === null ? null : positive(value.rule.maxMarketQuantity, '合约规则');
  try {
    rule.minNotional = decimal(value.rule.minNotional, { nonnegative: true });
    rule.maxNotional = value.rule.maxNotional === null || value.rule.maxNotional === undefined ? null : decimal(value.rule.maxNotional, { positive: true });
  } catch { throw new ExecutionError(502, '交易所名义金额规则无效'); }
  if (compareDecimals(rule.minQuantity, rule.maxQuantity) > 0 || !isMultiple(bid, rule.tickSize) || !isMultiple(ask, rule.tickSize)) throw new ExecutionError(502, '交易所盘口或合约步长不一致');
  return { symbol, bid, ask, at: new Date(at).toISOString(), rule };
}

export function splitQuantity(quantity, count, step) {
  if (!isMultiple(quantity, step)) throw new ExecutionError(400, `数量必须是 ${step} 的整数倍`);
  const lots = units(quantity) / units(step), base = lots / BigInt(count), extra = lots % BigInt(count);
  if (base <= 0n) throw new ExecutionError(400, '批次过多，至少一批数量小于合约步长');
  const result = Array.from({ length: count }, (_, index) => fromUnits((base + (BigInt(index) < extra ? 1n : 0n)) * units(step)));
  if (compareDecimals(addDecimals(result), quantity) !== 0) throw new ExecutionError(500, '拆批数量校验失败');
  return result;
}
/** Largest single order for this leg's order type; market orders have their own venue cap. */
export function maxOrderQuantity(rule, orderType = 'chase') {
  if (orderType !== 'market') return rule.maxQuantity;
  if (!rule.maxMarketQuantity) throw new ExecutionError(409, '该交易所合约不支持市价单');
  return compareDecimals(rule.maxMarketQuantity, rule.maxQuantity) < 0 ? rule.maxMarketQuantity : rule.maxQuantity;
}
export function checkChildQuantity(quantity, market, action, orderType = 'chase') {
  const { rule } = market, max = maxOrderQuantity(rule, orderType);
  if (!isMultiple(quantity, rule.quantityStep)) throw new ExecutionError(409, `下单数量须按 ${rule.quantityStep} 的步长填写`);
  if (compareDecimals(quantity, rule.minQuantity) < 0 || compareDecimals(quantity, max) > 0) throw new ExecutionError(409, `单批${orderType === 'market' ? '市价单' : ''}数量须在 ${rule.minQuantity} 至 ${max} 之间`);
  if (action === 'open' && compareNotional(quantity, market.bid, rule.minNotional, rule.contractSize) < 0n) throw new ExecutionError(409, `单批名义金额低于 ${rule.minNotional} ${rule.quoteAsset ?? 'USDT'}`);
  if (rule.maxNotional !== null && compareNotional(quantity, market.ask, rule.maxNotional, rule.contractSize) > 0n) throw new ExecutionError(409, '单批名义金额超过合约允许值');
}
export function checkContract(leg, market) {
  if (leg.exchange === 'hyperliquid') {
    if (!Number.isSafeInteger(leg.rule?.assetId) || leg.rule.assetId !== market.rule.assetId || compareDecimals(leg.rule.quantityStep, market.rule.quantityStep) !== 0) throw new ExecutionError(409, 'Hyperliquid 合约编号或数量精度已改变，请重新预览');
    return;
  }
  if (leg.exchange !== 'okx') return;
  if (!leg.rule?.contractSize || !market.rule.contractSize || leg.rule.instrumentId !== market.rule.instrumentId
    || compareDecimals(leg.rule.contractSize, market.rule.contractSize) !== 0) throw new ExecutionError(409, 'OKX 合约乘数或代码已改变，请重新预览');
}
/** A market leg or a chase leg without a limit never stops on price. */
export function stopReached(leg, market) {
  if (legOrderType(leg) === 'market' || leg.stopPrice === null || leg.stopPrice === undefined) return false;
  const price = leg.orderSide === 'buy' ? market.bid : market.ask;
  return leg.orderSide === 'buy' ? compareDecimals(price, leg.stopPrice) >= 0 : compareDecimals(price, leg.stopPrice) <= 0;
}
export function currentPosition(account, leg) {
  if (!object(account?.modes) || !['one-way', 'hedge'].includes(account.modes[leg.symbol]) || !Array.isArray(account.positions)) throw new ExecutionError(409, '无法确认该合约实际持仓模式，禁止下单');
  const matching = account.positions.filter(position => position.symbol === leg.symbol && position.side === leg.side);
  if (matching.length > 1) throw new ExecutionError(502, '交易所返回重复仓位，暂不下单');
  try { return matching.length ? decimal(matching[0].quantity, { nonnegative: true }) : '0'; }
  catch { throw new ExecutionError(502, '交易所仓位数量无效'); }
}
export function checkPosition(account, leg, action, quantity) {
  const current = currentPosition(account, leg);
  if (account.modes[leg.symbol] !== leg.positionMode) throw new ExecutionError(409, '持仓模式已改变，请重新预览');
  if (action === 'close' && compareDecimals(quantity, current) > 0) throw new ExecutionError(409, `${leg.exchange} ${leg.symbol} 可平数量不足`);
  if (action === 'open' && leg.positionMode === 'one-way' && account.positions.some(position => position.symbol === leg.symbol && position.side !== leg.side && compareDecimals(position.quantity, '0') > 0)) throw new WaitError(409, '单向模式已有反向仓位，请先明确平仓，不能把开仓变成隐式减仓');
  return current;
}
export function ensureNoExternalOrders(account, symbol, ownedIds = new Set()) {
  if (!Array.isArray(account.openOrders) || !Array.isArray(account.strategies)) throw new ExecutionError(502, '无法核对账户现有委托，暂不下单');
  if (account.openOrders.some(order => order.symbol === symbol && !ownedIds.has(order.id)) || account.strategies.some(strategy => strategy.symbol === symbol && strategy.status !== 'terminal' && !ownedIds.has(strategy.id))) throw new ExecutionError(409, `${symbol} 存在本任务之外的活动委托，请先处理后再预览`);
}

/**
 * Long and short totals in barrels (oil) or estimated USDT notional (hynix).
 * The whole group, each symbol across venues and each venue's own pair must
 * balance, so one venue's unit mistake cannot hide behind another's.
 */
function hedgeBalance(market, legs, shares) {
  const exposure = (leg, quantity) => market === 'oil' ? units(quantity) * units(leg.rule.contractSize ?? '1') / SCALE
    : market === 'anthropic' ? units(quantity) * units(sharesPerUnit(leg, shares, leg.rule.contractSize ?? '1')) / SCALE
    : units(notional(quantity, leg.orderSide === 'buy' ? leg.bid : leg.ask, leg.rule.contractSize ?? '1'));
  const unit = market === 'oil' ? ' 桶' : market === 'anthropic' ? ' 股' : ' USDT';
  const measure = (label, group) => {
    const total = side => group.filter(leg => leg.side === side).reduce((sum, leg) => sum + exposure(leg, leg.quantity), 0n);
    const long = total('long'), short = total('short'), larger = long > short ? long : short, gap = long > short ? long - short : short - long;
    const step = group.reduce((max, leg) => { const value = exposure(leg, leg.rule.quantityStep); return value > max ? value : max; }, 0n);
    return { balanced: gap <= step || gap * 20n <= larger, text: `${label}多头合计 ${fromUnits(long)}${unit}，空头合计 ${fromUnits(short)}${unit}` };
  };
  const hedged = group => group.length < legs.length && group.some(leg => leg.side === 'long') && group.some(leg => leg.side === 'short');
  const overall = measure('', legs), parts = [];
  for (const symbol of new Set(legs.map(leg => leg.symbol))) { const group = legs.filter(leg => leg.symbol === symbol); if (hedged(group)) parts.push(measure(`${symbol} 跨所`, group)); }
  for (const exchange of new Set(legs.map(leg => leg.exchange))) { const group = legs.filter(leg => leg.exchange === exchange); if (hedged(group)) parts.push(measure(`${TRADING_NAMES[exchange]} 所内`, group)); }
  const failed = [overall, ...parts].find(item => !item.balanced);
  return { balanced: !failed, text: overall.text, failed: failed?.text };
}

/** Native quantity for one leg of an equal-barrel (oil) or equal-notional (hynix) request. */
export function equalQuantity(intent, leg, market) {
  const { rule } = market, contractSize = rule.contractSize ?? '1', name = `${TRADING_NAMES[leg.exchange]} ${leg.symbol}`;
  if (intent.market === 'oil') {
    const scaled = units(intent.equalSize) * SCALE;
    if (scaled % units(contractSize) !== 0n) throw new ExecutionError(400, `${name} 每张 ${contractSize} 桶，桶数无法换算为整张`);
    const quantity = fromUnits(scaled / units(contractSize));
    if (!isMultiple(quantity, rule.quantityStep)) throw new ExecutionError(400, `${name} 每腿桶数须为 ${notional(rule.quantityStep, '1', contractSize)} 桶的整数倍`);
    return quantity;
  }
  if (intent.market === 'anthropic') {
    const perUnit = sharesPerUnit(leg, intent.shares, contractSize);
    const lots = units(intent.equalSize) * SCALE / (units(perUnit) * units(rule.quantityStep));
    if (lots <= 0n) throw new ExecutionError(400, `${name} 每腿股数不足一个下单步长（每单位约 ${perUnit} 股）`);
    return fromUnits(lots * units(rule.quantityStep));
  }
  // Size from the price the order will trade at (passive for chase, taker for
  // market), rounded down to the venue step.
  const taker = legOrderType(leg) === 'market';
  const price = (leg.orderSide === 'buy') !== taker ? market.bid : market.ask;
  const lots = units(intent.equalSize) * SCALE * SCALE / (units(price) * units(contractSize) * units(rule.quantityStep));
  if (lots <= 0n) throw new ExecutionError(400, `${name} 每腿名义金额不足一个下单步长`);
  return fromUnits(lots * units(rule.quantityStep));
}

// Hyperliquid margin mode and leverage are the account's own settings; this module only reports them.
function leverageOf(account, symbol) {
  const value = account?.leverage?.[symbol];
  if (!object(value) || !['cross', 'isolated'].includes(value.type) || !Number.isSafeInteger(value.value) || value.value < 1 || value.value > 100) throw new ExecutionError(502, `无法读取 Hyperliquid ${symbol} 当前杠杆，暂不下单`);
  return { type: value.type, value: value.value };
}
export function buildPlan(intent, snapshots, markets, connections, now, { resume = false } = {}) {
  let count = intent.batchCount;
  const prepared = intent.legs.map(input => {
    const account = snapshots.get(input.exchange), connection = connections.get(input.exchange);
    if (!connection?.connected) throw new ExecutionError(409, `${input.exchange} 尚未连接实盘账户`);
    const market = normalizeMarket(markets.get(`${input.exchange}:${input.symbol}`), input.symbol, now);
    const leg = { ...input, id: legId(input), orderType: legOrderType(input), stopPrice: input.stopPrice ?? null, orderSide: orderSide(intent.action, input.side), positionMode: account?.modes?.[input.symbol], accountRevision: connection.revision,
      ...(input.exchange === 'hyperliquid' ? { leverage: leverageOf(account, input.symbol) } : {}) };
    if (intent.equalSize) leg.quantity = equalQuantity(intent, leg, market);
    const currentQuantity = checkPosition(account, leg, intent.action, leg.quantity);
    ensureNoExternalOrders(account, leg.symbol);
    if (!isMultiple(leg.quantity, market.rule.quantityStep)) throw new ExecutionError(400, `${input.exchange} ${input.symbol} 数量须为 ${market.rule.quantityStep} 的整数倍`);
    if (leg.stopPrice !== null && !isMultiple(leg.stopPrice, market.rule.tickSize)) throw new ExecutionError(400, `${input.exchange} ${input.symbol} 追价界限须为 ${market.rule.tickSize} 的整数倍`);
    if (stopReached(leg, market)) throw new ExecutionError(409, `${input.exchange} ${input.symbol} 当前已达到追价界限`);
    const maxLots = units(maxOrderQuantity(market.rule, leg.orderType)) / units(market.rule.quantityStep);
    if (maxLots <= 0n) throw new ExecutionError(502, '交易所最大数量规则无效');
    const lots = units(leg.quantity) / units(market.rule.quantityStep), required = (lots + maxLots - 1n) / maxLots;
    if (required > BigInt(MAX_BATCHES)) throw new ExecutionError(400, `数量过大，需要超过 ${MAX_BATCHES} 批，请分成多次任务`);
    count = Math.max(count, Number(required));
    return { ...leg, currentQuantity, market };
  });
  const legs = prepared.map(({ market, ...leg }) => {
    const batchQuantities = splitQuantity(leg.quantity, count, market.rule.quantityStep);
    for (const quantity of batchQuantities) checkChildQuantity(quantity, market, intent.action, leg.orderType);
    return { ...leg, batchQuantities, estimatedNotional: notional(leg.quantity, (leg.orderSide === 'buy') !== (legOrderType(leg) === 'market') ? market.bid : market.ask, market.rule.contractSize), bid: market.bid, ask: market.ask, quoteAt: market.at, rule: market.rule };
  });
  // Anthropic legs are always measured in shares: independent rounding of each venue's step can leave a visible gap.
  const balance = intent.equalSize && intent.market !== 'anthropic' ? null : hedgeBalance(intent.market, legs, intent.shares);
  // Per-leg sizes are native units (OKX in contracts). A fresh open where any
  // hedged group differs by more than 5% or one order step is a unit mistake.
  if (balance && intent.action === 'open' && !resume && !balance.balanced) throw new ExecutionError(400, `多空两侧不平衡：${balance.failed}，请核对各所合约单位（OKX 按张）或改用${intent.market === 'oil' ? '等桶' : intent.market === 'anthropic' ? '等股数' : '等金额'}`);
  const sizing = intent.market === 'anthropic' ? [
    `股数假设：流通 ${intent.shares.outstanding} 十亿股、完全稀释 ${intent.shares.diluted} 十亿股；每单位折合 ${legs.map(leg => `${TRADING_NAMES[leg.exchange]} ${leg.symbol} ${sharesPerUnit(leg, intent.shares, leg.rule.contractSize ?? '1')} 股`).join('、')}。`,
    `${intent.equalSize ? `等股数配腿：每腿目标 ${intent.equalSize} 股，按下单步长向下取整；` : '逐腿数量：'}${balance.text}${balance.balanced ? '。' : `；${balance.failed}，两侧不平衡，请确认这是有意的数量。`}`,
    '换算按上市后结算口径假设，不保证各所价格收敛；价差、资金费和逐仓保证金风险需另行评估。',
  ] : balance ? [`逐腿数量：${balance.text}${balance.balanced ? '。' : `；${balance.failed}，两侧不平衡，请确认这是有意的数量。`}`] : intent.market === 'oil'
    ? [`等桶配腿：每腿 ${intent.equalSize} 桶，已按各所每张合约桶数换算为原生数量。`]
    : [`等金额配腿：每腿目标 ${intent.equalSize} USDT，按预览盘口向下取整到下单步长；各腿预估名义金额为 ${legs.map(leg => `${TRADING_NAMES[leg.exchange]} ${leg.symbol} ${leg.estimatedNotional}`).join('、')} USDT，成交价变动后实际金额会偏离。`];
  const chase = legs.filter(leg => leg.orderType === 'chase'), takers = legs.filter(leg => leg.orderType === 'market'), wallets = legs.filter(leg => leg.leverage);
  const names = group => group.map(leg => `${TRADING_NAMES[leg.exchange]} ${leg.symbol}`).join('、');
  return { ...intent, batchCount: count, legs,
    notes: [
      ...sizing,
      ...(chase.length ? [`追价限价腿：${names(chase)}。Bybit 使用原生追逐策略；Binance 使用 LIMIT / GTX / QUEUE，OKX 使用 post_only，同向一档追价调用原生改单并保留原订单号与总数量；Hyperliquid 以只挂单（ALO）挂在同侧最优价，价格变化时按原订单号撤单、确认结束后对剩余数量重新挂单。`] : []),
      ...(chase.some(leg => leg.stopPrice !== null) ? ['追价界限用于触达后停止追价并撤销余单，不是对所有成交价格的硬保证。'] : []),
      ...(chase.some(leg => leg.stopPrice === null) ? [`未设追价界限：${names(chase.filter(leg => leg.stopPrice === null))} 会一直跟随盘口，直到成交、手动停止或达到最长执行时间。`] : []),
      ...(takers.length ? [`市价腿：${names(takers)}。每批发送一次市价单，按对手盘吃单成交，不设价格界限，成交价可能明显偏离预览盘口；未全部成交（流动性不足或交易所价格保护）时暂停后续批次，不自动补单。${takers.some(leg => leg.exchange === 'hyperliquid') ? 'Hyperliquid 没有原生市价单，按对手价 ±1% 的立即成交否则取消（IOC）委托发送。' : ''}`] : []),
      ...(wallets.length ? [`Hyperliquid 按账户当前保证金模式与杠杆成交，本系统不修改：${wallets.map(leg => `${leg.symbol} ${leg.leverage.type === 'isolated' ? '逐仓' : '全仓'} ${leg.leverage.value}x`).join('、')}；逐仓仓位单独承担强平风险，请先在 Hyperliquid 确认保证金与杠杆。`] : []),
      '失败时不用市价补齐或回滚。',
      '同一批所有腿完成且委托终结后才进入下一批；任一腿失败会暂停后续批次并撤销余单，已成交仓位不会自动撤回。',
      ...(count > intent.batchCount ? [`按交易所单笔数量上限，批次数已从 ${intent.batchCount} 增加至 ${count}，请核对预览。`] : []),
    ] };
}

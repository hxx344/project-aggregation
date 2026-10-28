import { decimal, addDecimals, compareDecimals } from './trading-decimal.mjs';
import { TRADING_EXCHANGES, TRADING_NAMES, EXECUTION_MARKETS, EXECUTION_ALL_SYMBOLS } from './trading-markets.mjs';

const SCALE = 10n ** 18n;
export const EXECUTION_EXCHANGES = TRADING_EXCHANGES;
export const EXECUTION_SYMBOLS = EXECUTION_ALL_SYMBOLS;
// Oil legs hedge equal barrels; SK hynix ADR/ordinary legs hedge equal USDT notional.
export const EQUAL_SIZE_UNITS = Object.freeze({ oil: '桶', hynix: 'USDT' });
export const MAX_BATCHES = 200;
export const QUOTE_MAX_AGE = 10_000;

export class ExecutionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
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
  exactKeys(body, ['market', 'preset', 'action', 'legs', 'equalSize', 'batchCount', 'batchIntervalMs', 'repriceIntervalMs', 'timeoutMs']);
  // Requests from before the market selector are oil-only.
  const market = body.market ?? 'oil';
  if (!Object.hasOwn(EXECUTION_MARKETS, market)) throw new ExecutionError(400, '请选择支持的交易品种');
  const symbols = EXECUTION_MARKETS[market].symbols;
  if (!['four-leg', 'same-exchange', 'cross-exchange'].includes(body.preset) || !['open', 'close'].includes(body.action)) throw new ExecutionError(400, '请选择支持的交易预设与开平仓操作');
  if (!Array.isArray(body.legs) || body.legs.length !== (body.preset === 'four-leg' ? 4 : 2)) throw new ExecutionError(400, '交易腿数与所选预设不一致');
  const equalSize = body.equalSize === undefined ? null : positive(body.equalSize, market === 'oil' ? '每腿桶数' : '每腿名义金额');
  const identities = new Set();
  const legs = body.legs.map(value => {
    exactKeys(value, ['exchange', 'symbol', 'side', 'quantity', 'stopPrice']);
    if (!EXECUTION_EXCHANGES.includes(value.exchange) || !symbols.includes(value.symbol) || !['long', 'short'].includes(value.side)) throw new ExecutionError(400, '合约、交易所或仓位方向无效');
    const identity = `${value.exchange}:${value.symbol}`;
    if (identities.has(identity)) throw new ExecutionError(400, '同一交易所合约不能重复加入本次交易');
    identities.add(identity);
    if ((equalSize === null) === (value.quantity === undefined)) throw new ExecutionError(400, equalSize === null ? '请填写每腿数量' : '统一数量与逐腿数量只能选择一种');
    return { exchange: value.exchange, symbol: value.symbol, side: value.side, quantity: equalSize === null ? positive(value.quantity) : null, stopPrice: positive(value.stopPrice, '追价停止价') };
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
    if (a.side === b.side || (body.preset === 'same-exchange' ? a.exchange !== b.exchange || a.symbol === b.symbol : a.exchange === b.exchange || a.symbol !== b.symbol)) throw new ExecutionError(400, '双腿方向或合约组合与预设不一致');
  }
  return { market, preset: body.preset, action: body.action, legs, equalSize,
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
export function checkChildQuantity(quantity, market, action) {
  const { rule } = market;
  if (!isMultiple(quantity, rule.quantityStep)) throw new ExecutionError(409, `下单数量须按 ${rule.quantityStep} 的步长填写`);
  if (compareDecimals(quantity, rule.minQuantity) < 0 || compareDecimals(quantity, rule.maxQuantity) > 0) throw new ExecutionError(409, `单批数量须在 ${rule.minQuantity} 至 ${rule.maxQuantity} 之间`);
  if (action === 'open' && compareNotional(quantity, market.bid, rule.minNotional, rule.contractSize) < 0n) throw new ExecutionError(409, `单批名义金额低于 ${rule.minNotional} USDT`);
  if (rule.maxNotional !== null && compareNotional(quantity, market.ask, rule.maxNotional, rule.contractSize) > 0n) throw new ExecutionError(409, '单批名义金额超过合约允许值');
}
export function checkContract(leg, market) {
  if (leg.exchange !== 'okx') return;
  if (!leg.rule?.contractSize || !market.rule.contractSize || leg.rule.instrumentId !== market.rule.instrumentId
    || compareDecimals(leg.rule.contractSize, market.rule.contractSize) !== 0) throw new ExecutionError(409, 'OKX 合约乘数或代码已改变，请重新预览');
}
export function stopReached(leg, market) {
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
  if (action === 'open' && leg.positionMode === 'one-way' && account.positions.some(position => position.symbol === leg.symbol && position.side !== leg.side && compareDecimals(position.quantity, '0') > 0)) throw new ExecutionError(409, '单向模式已有反向仓位，请先明确平仓，不能把开仓变成隐式减仓');
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
function hedgeBalance(market, legs) {
  const exposure = (leg, quantity) => market === 'oil' ? units(quantity) * units(leg.rule.contractSize ?? '1') / SCALE : units(notional(quantity, leg.orderSide === 'buy' ? leg.bid : leg.ask, leg.rule.contractSize ?? '1'));
  const unit = market === 'oil' ? ' 桶' : ' USDT';
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
  // Size from the passive price the order will post at, rounded down to the venue step.
  const price = leg.orderSide === 'buy' ? market.bid : market.ask;
  const lots = units(intent.equalSize) * SCALE * SCALE / (units(price) * units(contractSize) * units(rule.quantityStep));
  if (lots <= 0n) throw new ExecutionError(400, `${name} 每腿名义金额不足一个下单步长`);
  return fromUnits(lots * units(rule.quantityStep));
}

export function buildPlan(intent, snapshots, markets, connections, now, { resume = false } = {}) {
  let count = intent.batchCount;
  const prepared = intent.legs.map(input => {
    const account = snapshots.get(input.exchange), connection = connections.get(input.exchange);
    if (!connection?.connected) throw new ExecutionError(409, `${input.exchange} 尚未连接实盘账户`);
    const market = normalizeMarket(markets.get(`${input.exchange}:${input.symbol}`), input.symbol, now);
    const leg = { ...input, id: legId(input), orderSide: orderSide(intent.action, input.side), positionMode: account?.modes?.[input.symbol], accountRevision: connection.revision };
    if (intent.equalSize) leg.quantity = equalQuantity(intent, leg, market);
    const currentQuantity = checkPosition(account, leg, intent.action, leg.quantity);
    ensureNoExternalOrders(account, leg.symbol);
    if (!isMultiple(leg.quantity, market.rule.quantityStep)) throw new ExecutionError(400, `${input.exchange} ${input.symbol} 数量须为 ${market.rule.quantityStep} 的整数倍`);
    if (!isMultiple(input.stopPrice, market.rule.tickSize)) throw new ExecutionError(400, `${input.exchange} ${input.symbol} 停止价须为 ${market.rule.tickSize} 的整数倍`);
    if (stopReached(leg, market)) throw new ExecutionError(409, `${input.exchange} ${input.symbol} 当前已达到追价停止价`);
    const maxLots = units(market.rule.maxQuantity) / units(market.rule.quantityStep);
    if (maxLots <= 0n) throw new ExecutionError(502, '交易所最大数量规则无效');
    const lots = units(leg.quantity) / units(market.rule.quantityStep), required = (lots + maxLots - 1n) / maxLots;
    if (required > BigInt(MAX_BATCHES)) throw new ExecutionError(400, `数量过大，需要超过 ${MAX_BATCHES} 批，请分成多次任务`);
    count = Math.max(count, Number(required));
    return { ...leg, currentQuantity, market };
  });
  const legs = prepared.map(({ market, ...leg }) => {
    const batchQuantities = splitQuantity(leg.quantity, count, market.rule.quantityStep);
    for (const quantity of batchQuantities) checkChildQuantity(quantity, market, intent.action);
    return { ...leg, batchQuantities, estimatedNotional: notional(leg.quantity, leg.orderSide === 'buy' ? market.bid : market.ask, market.rule.contractSize), bid: market.bid, ask: market.ask, quoteAt: market.at, rule: market.rule };
  });
  const balance = intent.equalSize ? null : hedgeBalance(intent.market, legs);
  // Per-leg sizes are native units (OKX in contracts). A fresh open where any
  // hedged group differs by more than 5% or one order step is a unit mistake.
  if (balance && intent.action === 'open' && !resume && !balance.balanced) throw new ExecutionError(400, `多空两侧不平衡：${balance.failed}，请核对各所合约单位（OKX 按张）或改用${intent.market === 'oil' ? '等桶' : '等金额'}`);
  const sizing = balance ? [`逐腿数量：${balance.text}${balance.balanced ? '。' : `；${balance.failed}，两侧不平衡，请确认这是有意的数量。`}`] : intent.market === 'oil'
    ? [`等桶配腿：每腿 ${intent.equalSize} 桶，已按各所每张合约桶数换算为原生数量。`]
    : [`等金额配腿：每腿目标 ${intent.equalSize} USDT，按预览盘口向下取整到下单步长；各腿预估名义金额为 ${legs.map(leg => `${TRADING_NAMES[leg.exchange]} ${leg.symbol} ${leg.estimatedNotional}`).join('、')} USDT，成交价变动后实际金额会偏离。`];
  return { ...intent, batchCount: count, legs,
    notes: [
      ...sizing,
      `本次交易所：${[...new Set(legs.map(leg => leg.exchange))].map(exchange => TRADING_NAMES[exchange]).join(' / ')}。Bybit 使用原生追逐策略；Binance 使用 LIMIT / GTX / QUEUE，OKX 使用 post_only，同向一档追价调用原生改单并保留原订单号与总数量。`,
      '停止价用于触达后停止追价并撤销余单，不是对所有成交价格的硬保证；不发送市价单，不用市价补齐或回滚。',
      '同一批所有腿完成且委托终结后才进入下一批；任一腿失败会暂停后续批次并撤销余单，已成交仓位不会自动撤回。',
      ...(count > intent.batchCount ? [`按交易所单笔数量上限，批次数已从 ${intent.batchCount} 增加至 ${count}，请核对预览。`] : []),
    ] };
}

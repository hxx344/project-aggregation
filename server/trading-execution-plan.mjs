import { decimal, addDecimals, compareDecimals } from './trading-decimal.mjs';

const SCALE = 10n ** 18n;
export const EXECUTION_EXCHANGES = ['binance', 'bybit'];
export const EXECUTION_SYMBOLS = ['CLUSDT', 'BZUSDT'];
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
export const notional = (quantity, price) => fromUnits(units(quantity) * units(price) / SCALE);
export const isMultiple = (value, step) => units(step) > 0n && units(value) % units(step) === 0n;
const compareNotional = (quantity, price, bound) => units(quantity) * units(price) - units(bound) * SCALE;
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ExecutionError(400, `${name}须在 ${min} 至 ${max} 之间`);
  return value;
}
export const legId = leg => `${leg.exchange}:${leg.symbol}:${leg.side}`;
export const orderSide = (action, side) => (action === 'open') === (side === 'long') ? 'buy' : 'sell';
export const positionSide = leg => leg.positionMode === 'one-way' ? 'BOTH' : leg.side === 'long' ? 'LONG' : 'SHORT';

export function normalizeIntent(body) {
  exactKeys(body, ['preset', 'action', 'legs', 'batchCount', 'batchIntervalMs', 'repriceIntervalMs', 'timeoutMs']);
  if (!['four-leg', 'same-exchange', 'cross-exchange'].includes(body.preset) || !['open', 'close'].includes(body.action)) throw new ExecutionError(400, '请选择支持的交易预设与开平仓操作');
  if (!Array.isArray(body.legs) || body.legs.length !== (body.preset === 'four-leg' ? 4 : 2)) throw new ExecutionError(400, '交易腿数与所选预设不一致');
  const identities = new Set();
  const legs = body.legs.map(value => {
    exactKeys(value, ['exchange', 'symbol', 'side', 'quantity', 'stopPrice']);
    if (!EXECUTION_EXCHANGES.includes(value.exchange) || !EXECUTION_SYMBOLS.includes(value.symbol) || !['long', 'short'].includes(value.side)) throw new ExecutionError(400, '合约、交易所或仓位方向无效');
    const identity = `${value.exchange}:${value.symbol}`;
    if (identities.has(identity)) throw new ExecutionError(400, '同一交易所合约不能重复加入本次交易');
    identities.add(identity);
    return { exchange: value.exchange, symbol: value.symbol, side: value.side, quantity: positive(value.quantity), stopPrice: positive(value.stopPrice, '追价停止价') };
  }).sort((a, b) => legId(a).localeCompare(legId(b)));
  if (body.preset === 'four-leg') {
    for (const exchange of EXECUTION_EXCHANGES) {
      const pair = legs.filter(leg => leg.exchange === exchange);
      if (pair.length !== 2 || pair[0].side === pair[1].side) throw new ExecutionError(400, '四腿预设要求每所 CL/BZ 方向相反');
    }
    for (const symbol of EXECUTION_SYMBOLS) if (new Set(legs.filter(leg => leg.symbol === symbol).map(leg => leg.side)).size !== 2) throw new ExecutionError(400, '四腿预设要求同品种跨所方向相反');
  } else {
    const [a, b] = legs;
    if (a.side === b.side || (body.preset === 'same-exchange' ? a.exchange !== b.exchange || a.symbol === b.symbol : a.exchange === b.exchange || a.symbol !== b.symbol)) throw new ExecutionError(400, '双腿方向或合约组合与预设不一致');
  }
  return { preset: body.preset, action: body.action, legs,
    batchCount: integer(body.batchCount, 1, MAX_BATCHES, '批次数'),
    batchIntervalMs: integer(body.batchIntervalMs, 0, 600_000, '批次间隔毫秒数'),
    repriceIntervalMs: integer(body.repriceIntervalMs, 1000, 60_000, 'Binance 追价间隔毫秒数'),
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
  if (action === 'open' && compareNotional(quantity, market.bid, rule.minNotional) < 0n) throw new ExecutionError(409, `单批名义金额低于 ${rule.minNotional} USDT`);
  if (rule.maxNotional !== null && compareNotional(quantity, market.ask, rule.maxNotional) > 0n) throw new ExecutionError(409, '单批名义金额超过合约允许值');
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

export function buildPlan(intent, snapshots, markets, connections, now) {
  let count = intent.batchCount;
  const prepared = intent.legs.map(input => {
    const account = snapshots.get(input.exchange), connection = connections.get(input.exchange);
    if (!connection?.connected) throw new ExecutionError(409, `${input.exchange} 尚未连接实盘账户`);
    const market = normalizeMarket(markets.get(`${input.exchange}:${input.symbol}`), input.symbol, now);
    const leg = { ...input, id: legId(input), orderSide: orderSide(intent.action, input.side), positionMode: account?.modes?.[input.symbol], accountRevision: connection.revision };
    const currentQuantity = checkPosition(account, leg, intent.action, input.quantity);
    ensureNoExternalOrders(account, leg.symbol);
    if (!isMultiple(input.quantity, market.rule.quantityStep)) throw new ExecutionError(400, `${input.exchange} ${input.symbol} 数量须为 ${market.rule.quantityStep} 的整数倍`);
    if (!isMultiple(input.stopPrice, market.rule.tickSize)) throw new ExecutionError(400, `${input.exchange} ${input.symbol} 停止价须为 ${market.rule.tickSize} 的整数倍`);
    if (stopReached(leg, market)) throw new ExecutionError(409, `${input.exchange} ${input.symbol} 当前已达到追价停止价`);
    const maxLots = units(market.rule.maxQuantity) / units(market.rule.quantityStep);
    if (maxLots <= 0n) throw new ExecutionError(502, '交易所最大数量规则无效');
    const lots = units(input.quantity) / units(market.rule.quantityStep), required = (lots + maxLots - 1n) / maxLots;
    if (required > BigInt(MAX_BATCHES)) throw new ExecutionError(400, `数量过大，需要超过 ${MAX_BATCHES} 批，请分成多次任务`);
    count = Math.max(count, Number(required));
    return { ...leg, currentQuantity, market };
  });
  const legs = prepared.map(({ market, ...leg }) => {
    const batchQuantities = splitQuantity(leg.quantity, count, market.rule.quantityStep);
    for (const quantity of batchQuantities) checkChildQuantity(quantity, market, intent.action);
    return { ...leg, batchQuantities, estimatedNotional: notional(leg.quantity, leg.orderSide === 'buy' ? market.bid : market.ask), bid: market.bid, ask: market.ask, quoteAt: market.at, rule: market.rule };
  });
  return { ...intent, batchCount: count, legs,
    notes: [
      'Bybit 使用交易所原生追逐限价策略（PostOnly）；Binance 使用 LIMIT / GTX / QUEUE 同向一档，由服务按设定间隔调用原生改单接口追价，保留原订单号与总数量。',
      '停止价用于触达后停止追价并撤销余单，不是对所有成交价格的硬保证；不发送市价单，不用市价补齐或回滚。',
      '同一批所有腿完成且委托终结后才进入下一批；任一腿失败会暂停后续批次并撤销余单，已成交仓位不会自动撤回。',
      ...(count > intent.batchCount ? [`按交易所单笔数量上限，批次数已从 ${intent.batchCount} 增加至 ${count}，请核对预览。`] : []),
    ] };
}

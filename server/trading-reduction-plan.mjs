import { decimal, compareDecimals } from './trading-decimal.mjs';
import { ExecutionError, exactKeys, normalizeIntent, normalizeMarket, units, fromUnits } from './trading-execution-plan.mjs';

export const REDUCTION_RISK_MAX_AGE_MS = 30_000;
const ONE = units('1');

function percent(value, name) {
  if (typeof value !== 'string' || value.length > 48) throw new ExecutionError(400, `${name}须为大于 0 且不超过 100 的十进制百分比`);
  let result;
  try { result = decimal(value, { positive: true }); } catch { throw new ExecutionError(400, `${name}须为大于 0 且不超过 100 的十进制百分比`); }
  if (compareDecimals(result, '100') > 0) throw new ExecutionError(400, `${name}不能超过 100%`);
  return result;
}

export function reductionIntent(config, quantities = null) {
  return { market: 'anthropic', preset: config.legs[0].exchange === config.legs[1].exchange ? 'same-exchange' : 'cross-exchange', action: 'close', shares: config.shares,
    legs: config.legs.map(leg => ({ ...leg, quantity: quantities?.get(`${leg.exchange}:${leg.symbol}:${leg.side}`) ?? '1', orderType: 'market', stopPrice: null })),
    batchCount: config.batchCount, batchIntervalMs: config.batchIntervalMs, repriceIntervalMs: 1000, timeoutMs: config.timeoutMs };
}

export function checkReductionDuration(batchCount, intervalMs, timeoutMs) {
  if (timeoutMs < (batchCount - 1) * intervalMs + 30_000) throw new ExecutionError(400, '最长执行时间须覆盖全部批次间隔并至少预留 30 秒执行时间');
}

export function normalizeReductionConfig(value) {
  exactKeys(value, ['enabled', 'legs', 'shares', 'thresholdPercent', 'reducePercent', 'batchCount', 'batchIntervalMs', 'timeoutMs']);
  if (typeof value.enabled !== 'boolean') throw new ExecutionError(400, '请选择是否启用自动减仓');
  if (!Array.isArray(value.legs) || value.legs.length !== 2) throw new ExecutionError(400, '自动减仓必须选择两条交易腿');
  for (const leg of value.legs) exactKeys(leg, ['exchange', 'symbol', 'side']);
  const intent = normalizeIntent(reductionIntent(value));
  const config = { enabled: value.enabled, legs: intent.legs.map(({ exchange, symbol, side }) => ({ exchange, symbol, side })), shares: intent.shares,
    thresholdPercent: percent(value.thresholdPercent, '强平距离阈值'), reducePercent: percent(value.reducePercent, '总减仓比例'),
    batchCount: intent.batchCount, batchIntervalMs: intent.batchIntervalMs, timeoutMs: intent.timeoutMs };
  checkReductionDuration(config.batchCount, config.batchIntervalMs, config.timeoutMs);
  return config;
}

/** Exact comparison uses raw prices; rounding the displayed distance must never trigger a trade. */
export function readReductionRisk(config, snapshots, now) {
  const legs = config.legs.map(leg => {
    const rows = snapshots.get(leg.exchange)?.positions?.filter(row => row.symbol === leg.symbol && row.side === leg.side) ?? [];
    const name = `${leg.exchange} ${leg.symbol}`;
    if (rows.length !== 1) throw new ExecutionError(409, `${name} 所选方向没有唯一可确认的持仓，自动减仓未发送`);
    const row = rows[0];
    let quantity, mark, liquidation;
    try { quantity = decimal(row.quantity, { positive: true }); mark = units(decimal(row.risk?.markPrice, { positive: true })); liquidation = units(decimal(row.risk?.liquidationPrice, { positive: true })); }
    catch { throw new ExecutionError(502, `${name} 缺少有效的标记价、强平价或持仓数量，自动减仓未发送`); }
    const at = typeof row.risk?.at === 'string' ? Date.parse(row.risk.at) : NaN;
    if (!Number.isFinite(at) || now - at > REDUCTION_RISK_MAX_AGE_MS || at - now > 1000) throw new ExecutionError(502, `${name} 强平风险快照已过期或时间无效，自动减仓未发送`);
    const raw = leg.side === 'long' ? mark - liquidation : liquidation - mark, distance = raw > 0n ? raw : 0n;
    return { ...leg, quantity, distancePercent: fromUnits(distance * 100n * ONE / mark), met: distance * 100n * ONE <= units(config.thresholdPercent) * mark };
  });
  return { checkedAt: new Date(now).toISOString(), legs, met: legs.some(leg => leg.met) };
}

export function reductionQuantities(config, reading, markets, now) {
  const result = new Map();
  for (const leg of reading.legs) {
    const market = normalizeMarket(markets.get(`${leg.exchange}:${leg.symbol}`), leg.symbol, now, leg.exchange), step = units(market.rule.quantityStep);
    const lots = units(leg.quantity) * units(config.reducePercent) / (100n * ONE * step);
    if (lots <= 0n) throw new ExecutionError(400, `${leg.exchange} ${leg.symbol} 减仓量不足一个下单步长，请提高比例`);
    result.set(`${leg.exchange}:${leg.symbol}:${leg.side}`, fromUnits(lots * step));
  }
  return result;
}

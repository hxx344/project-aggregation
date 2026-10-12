import Decimal from 'decimal.js';

export type OpenCapacityInput = {
  order: { symbol: string; side: 'BUY' | 'SELL'; orderType: 'LIMIT' | 'MARKET'; timeInForce: 'GTC' | 'IOC' | 'FOK' | 'POC'; price?: string; quantity?: string };
} | { pair: { longSymbol: string; shortSymbol: string; quantity?: string } };

export type OpenCapacityLeg = {
  symbol: string; side: string; quoteCurrency: string;
  leverage: string | null; maxLeverage: string | null;
  maxQuantity: string | null; maxNotionalUSDT: string | null;
  notionalUSDT: string | null; requiredMargin: string | null; availableMargin: string | null;
};
export type OpenCapacity = {
  status: 'ready' | 'blocked' | 'unavailable'; reason: string | null;
  asOf: number; expiresAt: number; connectionVersion: string | number; base: string;
  maxQuantity: string | null; maxNotionalUSDT: string | null; requiredMargin: string | null;
  marginCurrency: 'USDT'; reserveFactor: string; inputWithinCapacity: boolean | null;
  limitingFactors: string[]; notes: string[]; legs: OpenCapacityLeg[];
};

const finiteDecimal = (value: unknown) => {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 160) return false;
  try { return new Decimal(value).isFinite(); } catch { return false; }
};
const nonnegative = (value: unknown) => finiteDecimal(value) && (value === null || new Decimal(value as string).gte(0));
const positiveOrNull = (value: unknown) => nonnegative(value) && (value === null || new Decimal(value as string).gt(0));
const textList = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Bind responses to the selected instruments and account; never infer missing limits. */
export function parseOpenCapacity(raw: unknown, input: OpenCapacityInput, connectionVersion: string | number): OpenCapacity {
  const value = raw as OpenCapacity;
  const selected = 'order' in input ? [[input.order.symbol, input.order.side]] : [[input.pair.longSymbol, 'BUY'], [input.pair.shortSymbol, 'SELL']];
  if (!value || !['ready', 'blocked', 'unavailable'].includes(value.status) || value.connectionVersion !== connectionVersion
    || !Number.isFinite(value.asOf) || !Number.isFinite(value.expiresAt) || value.expiresAt < value.asOf
    || typeof value.base !== 'string' || value.marginCurrency !== 'USDT' || value.reserveFactor !== '1.10'
    || !(value.reason === null || typeof value.reason === 'string') || ![null, true, false].includes(value.inputWithinCapacity)
    || !textList(value.limitingFactors) || !textList(value.notes) || !Array.isArray(value.legs)
    || ![value.maxQuantity, value.maxNotionalUSDT, value.requiredMargin].every(nonnegative)) throw new Error('开仓估算数据不完整，等待重新读取');
  if ((value.status === 'ready' && value.legs.length !== selected.length) || value.legs.length > selected.length
    || value.legs.some((leg, index) => !leg || leg.symbol !== selected[index][0] || leg.side !== selected[index][1]
      || leg.quoteCurrency !== leg.symbol.split('_').at(-1)
      || ![leg.leverage, leg.maxLeverage].every(positiveOrNull)
      || !finiteDecimal(leg.availableMargin)
      || ![leg.maxQuantity, leg.maxNotionalUSDT, leg.notionalUSDT, leg.requiredMargin].every(nonnegative))) throw new Error('开仓估算与所选合约不匹配，等待重新读取');
  if (value.status === 'ready' && (value.maxQuantity === null || value.maxNotionalUSDT === null || value.legs.some(leg => leg.leverage === null))) throw new Error('开仓额度尚未核实');
  if (value.status !== 'ready' && value.maxQuantity !== null && new Decimal(value.maxQuantity).gt(0)) throw new Error('开仓额度状态不一致，等待重新读取');
  return value;
}

export function capacityIsFresh(value: OpenCapacity, now: number) {
  return Number.isFinite(now) && value.asOf <= now + 1000 && now < value.expiresAt;
}

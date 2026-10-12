import type { Position } from './positions-types.ts';
import { createHash } from 'node:crypto';

export const POSITIONS_INVALID = '仓位数据不完整，已保留上次完整快照';
export const POSITIONS_FAILED = '仓位读取失败，请检查连接、读取权限及服务器时间；已保留上次完整快照';
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(POSITIONS_INVALID);
  return value as Record<string, unknown>;
}
export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(POSITIONS_INVALID);
  return value.map(record);
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:/ -]{1,160}$/.test(value)) throw new Error(POSITIONS_INVALID);
  return value;
}
export function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(POSITIONS_INVALID);
  return value;
}
export function optionalDecimal(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : decimal(value);
}
export const isZero = (value: string) => !/[1-9]/.test(value);
export const absolute = (value: string) => value.replace(/^-/, '');
export function multiplyDecimals(left: string, right: string): string {
  const parts = [decimal(left), decimal(right)].map(value => ({ digits: BigInt(value.replace('.', '')), scale: value.split('.')[1]?.length ?? 0 }));
  const product = parts[0].digits * parts[1].digits, scale = parts[0].scale + parts[1].scale;
  const sign = product < BigInt(0) ? '-' : '';
  const digits = absolute(product.toString()).padStart(scale + 1, '0');
  const result = scale ? sign + digits.slice(0, -scale) + '.' + digits.slice(-scale) : sign + digits;
  return decimal(result);
}
export const positionId = (...fields: string[]) => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
export function timestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return null;
  const parsed = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : Date.parse(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Date.now() + 60_000) throw new Error(POSITIONS_INVALID);
  return new Date(parsed).toISOString();
}
export function position(instrumentId: string, side: Position['side'], quantity: string, quantityUnit: string): Position {
  return { id: positionId(instrumentId, side), symbol: instrumentId, instrumentId, side, quantity: absolute(quantity), quantityUnit,
    contractSize: null, entryPrice: null, markPrice: null, notional: null, unrealizedPnl: null, leverage: null,
    liquidationPrice: null, priceCurrency: null, notionalCurrency: null, pnlCurrency: null, marginMode: null, sourceUpdatedAt: null };
}
export function uniquePositions(positions: Position[]): Position[] {
  const ids = new Set<string>();
  for (const item of positions) {
    if (ids.has(item.id)) throw new Error(POSITIONS_INVALID);
    ids.add(item.id);
  }
  return positions;
}

// Field readers for venue answers. A malformed field throws a ShapeError; each call site decides what it means
// (read-failed for a read, uncertain for the answer to a write).
import { decimal, type Sign } from '../decimal.ts';
import { isRecord } from './http.ts';

export class ShapeError extends Error {}
const shape = (message: string): never => { throw new ShapeError(message); };

export function record(value: unknown, name: string): Record<string, unknown> {
  return isRecord(value) ? value : shape(`${name}不是对象`);
}
export function list(value: unknown, name: string, limit = 5_000): unknown[] {
  return Array.isArray(value) && value.length <= limit ? value : shape(`${name}不是有效列表`);
}
export function amount(value: unknown, name: string, sign: Sign = 'positive'): string {
  if (typeof value !== 'string') return shape(`${name}缺失`);
  try { return decimal(value, sign); } catch { return shape(`${name}无效`); }
}
/** Absent, empty or zero means no price (nothing filled yet). */
export function optionalPrice(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = amount(value, name, 'nonnegative');
  return parsed === '0' ? null : parsed;
}
export function millis(value: unknown, name: string): number {
  const parsed = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 && parsed < 8_640_000_000_000_000 ? parsed : shape(`${name}无效`);
}
export function identifier(value: unknown, name: string): string {
  const parsed = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof parsed === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(parsed) ? parsed : shape(`${name}无效`);
}
export const describe = (error: unknown): string => error instanceof Error ? error.message.slice(0, 160) : '未知错误';

export interface LiveCredentials { apiKey: string; apiSecret: string }
/** In hedge mode the position side alone says whether an order opens or closes: selling a long or buying a short closes. */
export const hedgeClose = (side: 'buy' | 'sell', positionSide: 'long' | 'short'): boolean => (positionSide === 'long') === (side === 'sell');

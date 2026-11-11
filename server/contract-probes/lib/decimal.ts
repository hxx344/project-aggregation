// Exact decimals for quantities, prices and money. Values travel as canonical
// decimal strings and are computed as scaled bigints; binary floating point is
// never used, so a fill, a step or a fee cannot drift by rounding.
const SCALE_DIGITS = 18;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const MAX_INTEGER_DIGITS = 60;
const PATTERN = /^-?\d+(?:\.\d{1,18})?$/;

export class DecimalError extends TypeError {}

export function units(value: string): bigint {
  if (typeof value !== 'string' || value.length > MAX_INTEGER_DIGITS + SCALE_DIGITS + 2 || !PATTERN.test(value)) throw new DecimalError(`不是有效的十进制数值：${String(value).slice(0, 40)}`);
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  if (integer.length > MAX_INTEGER_DIGITS) throw new DecimalError('十进制数值超出支持范围');
  const magnitude = BigInt(integer) * SCALE + BigInt(fraction.padEnd(SCALE_DIGITS, '0'));
  return negative ? -magnitude : magnitude;
}

export function fromUnits(value: bigint): string {
  const negative = value < 0n, magnitude = negative ? -value : value;
  const integer = String(magnitude / SCALE);
  if (integer.length > MAX_INTEGER_DIGITS) throw new DecimalError('十进制数值超出支持范围');
  const fraction = String(magnitude % SCALE).padStart(SCALE_DIGITS, '0').replace(/0+$/, '');
  return (negative && magnitude !== 0n ? '-' : '') + integer + (fraction ? '.' + fraction : '');
}

export type Sign = 'any' | 'positive' | 'nonnegative';

/** Canonical form; also the runtime check for every decimal field at a boundary. */
export function decimal(value: unknown, sign: Sign = 'any'): string {
  if (typeof value !== 'string') throw new DecimalError('十进制数值必须以字符串传递');
  const scaled = units(value);
  if (sign === 'positive' && scaled <= 0n) throw new DecimalError('数值必须为正');
  if (sign === 'nonnegative' && scaled < 0n) throw new DecimalError('数值不能为负');
  return fromUnits(scaled);
}

export const add = (...values: string[]): string => fromUnits(values.reduce((sum, value) => sum + units(value), 0n));
export const sub = (left: string, right: string): string => fromUnits(units(left) - units(right));
export const cmp = (left: string, right: string): -1 | 0 | 1 => { const a = units(left), b = units(right); return a < b ? -1 : a > b ? 1 : 0; };
export const isZero = (value: string): boolean => units(value) === 0n;
export const min = (left: string, right: string): string => cmp(left, right) <= 0 ? decimal(left) : decimal(right);
/** Product truncated toward zero at 18 fractional digits. */
export const mul = (left: string, right: string): string => fromUnits(units(left) * units(right) / SCALE);
export function isMultiple(value: string, step: string): boolean {
  const unit = units(step);
  return unit > 0n && units(value) % unit === 0n;
}
/** value × (10000 + bps) / 10000 rounded to a step toward the inside of the band: down when widening upward, up when widening downward. */
export function bandEdge(value: string, bps: number, direction: 'up' | 'down', step: string): string {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps >= 10_000) throw new DecimalError('价格保护基点无效');
  const unit = units(step), base = units(value);
  if (unit <= 0n || base <= 0n) throw new DecimalError('价格保护只接受正价格和正步长');
  const scaled = base * BigInt(direction === 'up' ? 10_000 + bps : 10_000 - bps), tick = unit * 10_000n;
  const steps = direction === 'up' ? scaled / tick : (scaled + tick - 1n) / tick;
  return fromUnits(steps * unit);
}
/** Largest multiple of step not above a nonnegative value. */
export function floorToStep(value: string, step: string): string {
  const unit = units(step), scaled = units(value);
  if (unit <= 0n || scaled < 0n) throw new DecimalError('步长取整只接受正步长和非负数值');
  return fromUnits(scaled - scaled % unit);
}

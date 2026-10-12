import DecimalJs from 'decimal.js';

// Keep all intermediate money/quantity arithmetic decimal; convert only at UI boundaries.
export const Decimal = DecimalJs.clone({ precision: 80, rounding: DecimalJs.ROUND_HALF_UP, toExpNeg: -100, toExpPos: 100 });
export function D(value) {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) throw new RangeError('金额或数量必须是有限数值');
  return decimal;
}

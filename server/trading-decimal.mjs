// Financial values remain decimal strings. No binary floating-point arithmetic is
// used for normalization, aggregation, comparison, or changes of sign.
const SCALE = 10n ** 18n;
const MAX_DIGITS = 60;

function scaled(value) {
  // Numeric inputs are accepted only when they are exact safe integers.
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || value.length > MAX_DIGITS + 20 || !/^-?\d+(?:\.\d{1,18})?$/.test(value)) {
    throw new TypeError('金额不是有效的十进制数值');
  }
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  if (integer.length > MAX_DIGITS) throw new TypeError('金额超出支持范围');
  const magnitude = BigInt(integer) * SCALE + BigInt(fraction.padEnd(18, '0'));
  return negative ? -magnitude : magnitude;
}

function formatted(value) {
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  const integer = String(magnitude / SCALE);
  if (integer.length > MAX_DIGITS) throw new TypeError('金额超出支持范围');
  const fraction = String(magnitude % SCALE).padStart(18, '0').replace(/0+$/, '');
  return sign + integer + (fraction ? '.' + fraction : '');
}

export function decimal(value, { positive = false, nonnegative = false } = {}) {
  const number = scaled(value);
  if ((positive && number <= 0n) || (nonnegative && number < 0n)) throw new TypeError('金额方向不符合字段要求');
  return formatted(number);
}

export function addDecimals(values) {
  if (!Array.isArray(values)) throw new TypeError('金额集合无效');
  return formatted(values.reduce((sum, value) => sum + scaled(value), 0n));
}

export function negateDecimal(value) { return formatted(-scaled(value)); }
export function compareDecimals(a, b) {
  const left = scaled(a), right = scaled(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

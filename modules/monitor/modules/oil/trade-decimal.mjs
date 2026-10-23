// Preserve exact cash flows and native quantities. Only chart coordinates use Number.
export function decimal(value) {
  const [whole, fraction = ''] = value.split('.');
  return { n: BigInt(whole + fraction), scale: fraction.length };
}
export function decimalText({ n, scale }) {
  const sign = n < 0n ? '-' : '', digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
  return sign + text;
}
export function add(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return { n: a.n * 10n ** BigInt(scale - a.scale) + b.n * 10n ** BigInt(scale - b.scale), scale };
}
export const negate = a => ({ ...a, n: -a.n });
export const absolute = a => ({ ...a, n: a.n < 0n ? -a.n : a.n });
export const compare = (a, b) => { const n = add(a, negate(b)).n; return n < 0n ? -1 : n > 0n ? 1 : 0; };
export const multiply = (a, b) => ({ n: a.n * b.n, scale: a.scale + b.scale });
/** Bound recurring weighted prices without truncating the source's fractional precision. */
export function divide(a, b, scale = Math.max(24, a.scale, b.scale)) {
  if (b.n === 0n) return null;
  const numerator = a.n * 10n ** BigInt(b.scale + scale), denominator = b.n * 10n ** BigInt(a.scale);
  return { n: numerator / denominator, scale };
}

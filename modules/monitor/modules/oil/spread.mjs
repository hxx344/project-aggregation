/** Brent − WTI in USDT per barrel, subtracted on the decimal quotes; null means the pair is unavailable. */
export function oilSpread(brent, wti) {
  if (![brent, wti].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) return null;
  const value = decimalDifference(brent, wti);
  return Number.isFinite(value) ? value : null;
}

// Powers of ten up to 1e22 are exact doubles.
const POWERS_OF_TEN = Array.from({ length: 23 }, (_, exponent) => Number(`1e${exponent}`));

export function decimalDifference(left, right) {
  const parts = value => {
    const [mantissa, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return { digits: whole + fraction, scale: fraction.length - Number(exponent) };
  };
  const a = parts(left), b = parts(right), scale = Math.max(0, a.scale, b.scale);
  const shiftA = scale - a.scale, shiftB = scale - b.scale;
  if (scale < POWERS_OF_TEN.length && shiftA < POWERS_OF_TEN.length && shiftB < POWERS_OF_TEN.length) {
    // Safe-integer products and differences are exact, and one IEEE division rounds the
    // exact decimal quotient exactly like Number() parses the BigInt path's decimal string.
    const x = Number(a.digits) * POWERS_OF_TEN[shiftA], y = Number(b.digits) * POWERS_OF_TEN[shiftB], difference = x - y;
    if (Number.isSafeInteger(x) && Number.isSafeInteger(y) && Number.isSafeInteger(difference)) return difference / POWERS_OF_TEN[scale];
  }
  const difference = BigInt(a.digits) * 10n ** BigInt(shiftA) - BigInt(b.digits) * 10n ** BigInt(shiftB);
  const digits = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, '0');
  return Number((difference < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}

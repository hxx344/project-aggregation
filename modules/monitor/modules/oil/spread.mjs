/** Signed percentage points relative to WTI; null means the pair is unavailable. */
export function oilSpreadPercent(brent, wti) {
  if (![brent, wti].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) return null;
  const value = decimalDifference(brent, wti) / wti * 100;
  return Number.isFinite(value) ? value : null;
}

export function decimalDifference(left, right) {
  const parts = value => {
    const [mantissa, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return { integer: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
  };
  const a = parts(left), b = parts(right), scale = Math.max(0, a.scale, b.scale);
  const difference = a.integer * 10n ** BigInt(scale - a.scale) - b.integer * 10n ** BigInt(scale - b.scale);
  const digits = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, '0');
  return Number((difference < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}

// Shared display helpers for the trading center tabs.

const shortTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fullTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Beijing time; `withYear` for ranges that can span a year boundary. */
export function beijingTime(value: string | null, fallback = '尚未读取', withYear = false) {
  return value && Number.isFinite(Date.parse(value)) ? (withYear ? fullTime : shortTime).format(new Date(value)) : fallback;
}

// Exchange decimal strings are shown as sent: positions and receipts can exceed Number precision.
export function amount(value: string | null, signed = false) {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return '—';
  const negative = value.startsWith('-'), nonzero = /[1-9]/.test(value);
  const [integer, fraction] = value.replace(/^-/, '').split('.');
  const decimals = fraction?.replace(/0+$/, '');
  return `${negative && nonzero ? '−' : signed && nonzero ? '+' : ''}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${decimals ? `.${decimals}` : ''}`;
}

export const polarity = (value: string | null) => value === null || !/[1-9]/.test(value) ? '' : value.startsWith('-') ? 'trading-negative' : 'trading-positive';

/** Decimal string rounded half-up to `digits` places for compact views; the exact value stays in the detailed tables. */
export function roundedAmount(value: string | null, signed = false, digits = 2) {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return '—';
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = value.replace(/^-/, '').split('.');
  const scaled = BigInt(integer + fraction.padEnd(digits, '0').slice(0, digits)) + (Number(fraction[digits] ?? '0') >= 5 ? 1n : 0n);
  const text = scaled.toString().padStart(digits + 1, '0');
  const rounded = digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  return amount(negative ? `-${rounded}` : rounded, signed);
}

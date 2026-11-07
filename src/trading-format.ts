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

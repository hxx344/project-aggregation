import Decimal from 'decimal.js';
const ExactDecimal = Decimal.clone({ precision: 100 });

/** Preserve exchange decimal strings instead of rounding them through Number. */
export function exact(value: string | null | undefined): string {
  if (value == null || !value.trim()) return '—';
  try { return new Decimal(value).isFinite() ? new Decimal(value).toFixed() : '—'; } catch { return '—'; }
}

export type DecimalKind = 'price' | 'quantity' | 'amount' | 'rate';
const displayPrecision: Record<DecimalKind, { places: number; significant: number }> = {
  price: { places: 8, significant: 10 }, quantity: { places: 8, significant: 10 },
  amount: { places: 4, significant: 10 }, rate: { places: 4, significant: 8 },
};

/** Display only: never use the rounded result for arithmetic, inputs or requests. */
export function formatDecimal(value: string | null | undefined, kind: DecimalKind = 'quantity'): string {
  if (value == null || !value.trim()) return '—';
  try {
    const number = new ExactDecimal(value);
    if (!number.isFinite()) return '—';
    if (number.isZero()) return '0';
    const { places, significant } = displayPrecision[kind];
    // Tiny fees and residual exposure must remain visible instead of rounding to zero.
    const rounded = number.abs().lt(new ExactDecimal(10).pow(-places))
      ? number.toSignificantDigits(4, Decimal.ROUND_HALF_UP)
      : number.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toSignificantDigits(significant, Decimal.ROUND_HALF_UP);
    if (rounded.abs().lt('0.00000001') || rounded.abs().gte('10000000000')) return rounded.toSignificantDigits(6).toExponential();
    const fixed = rounded.toFixed();
    return fixed.replace('-', '').length > 14 ? rounded.toSignificantDigits(6).toExponential() : fixed;
  } catch { return '—'; }
}

export function formatSigned(value: string | null | undefined, kind: DecimalKind = 'quantity'): string {
  const formatted = formatDecimal(value, kind);
  return formatted !== '—' && new ExactDecimal(value!).gt(0) ? '+' + formatted : formatted;
}

export function signedAmount(value: string | null | undefined): string {
  const result = exact(value);
  if (result === '—') return result;
  return new Decimal(result).gt(0) ? '+' + result : result;
}

export function amountClass(value: string | null | undefined): string {
  if (exact(value) === '—') return 'muted';
  return new Decimal(value!).lt(0) ? 'negative' : new Decimal(value!).gt(0) ? 'positive' : '';
}

export function liquidationPrice(value: string | null | undefined): string | null {
  const amount = exact(value);
  return amount !== '—' && new Decimal(amount).gt(0) ? amount : null;
}

export function positiveQuantity(value: string): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return false;
  try { return new Decimal(value).gt(0); } catch { return false; }
}

export function netBaseQuantity(legs: { side: string; baseQuantity: string | null }[]): string | null {
  let total = new ExactDecimal(0);
  for (const leg of legs) {
    const side = leg.side.toLowerCase();
    if (leg.baseQuantity == null || !['long', 'short'].includes(side) || exact(leg.baseQuantity) === '—') return null;
    const quantity = new ExactDecimal(leg.baseQuantity).abs();
    total = side === 'long' ? total.add(quantity) : total.sub(quantity);
  }
  return total.toFixed();
}

export const liveStatus = (status: string) => ({
  live: '已同步', connected: '已连接', ready: '已连接', disconnected: '未连接', unconfigured: '未连接',
  configured: '待校验', connecting: '连接中', partial: '数据不完整', stale: '数据已过期', offline: '连接中断',
  error: '连接异常', unavailable: '暂不可用', unknown: '状态待确认', pending: '待交易所确认',
  open: '挂单中', new: '挂单中', filled: '全部成交', partially_filled: '部分成交', partiallyFilled: '部分成交',
  cancelled: '已撤单', canceled: '已撤单', rejected: '已拒单', cancel_pending: '撤单待确认',
  submitting: '提交中', submitted: '已提交', completed: '已确认', failed: '未完成', blocked: '已阻止',
  sending: '发送中', prepared: '待提交', unsent: '未发送', invalid: '无效委托', fail: '失败', reject: '已拒单',
  needs_review: '需手动核对', reconciling: '正在核对订单',
}[status.toLowerCase()] || status);

export const sideLabel = (side: string) => ({ long: '做多', short: '做空', buy: '买入', sell: '卖出', none: '单向持仓', unknown: '方向未知' }[side.toLowerCase()] || side);
export const executionStatus = (state: string) => state.toLowerCase() === 'partial' ? '部分成交，需处理敞口' : liveStatus(state);
export const stateIsUncertain = (state: string) => ['UNKNOWN', 'SENDING', 'SUBMITTING', 'CANCEL_PENDING', 'RECONCILING', 'INVALID'].includes(state.toUpperCase());

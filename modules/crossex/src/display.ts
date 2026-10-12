export function format(value: number | string | null | undefined, digits = 2) {
  if (value == null || typeof value === 'string' && !value.trim()) return '—';
  const number = Number(value);
  return !Number.isFinite(number) ? '—' : number.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无时间';
export const venues: Record<string, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', kraken: 'Kraken', hyperliquid: 'Hyperliquid', lighter: 'Lighter', deribit: 'Deribit' };
export const venue = (name: string) => venues[name] || name;
export const direction = (row: { long: { exchange: string }; short: { exchange: string } }) => `${venue(row.long.exchange)} 做多 → ${venue(row.short.exchange)} 做空`;
export const stateLabel = (state: string) => ({ live: '已连接', partial: '部分行情可用', offline: '未连接', stale: '数据过期', cached: '使用缓存', unavailable: '等待连接', connecting: '连接中', error: '连接异常', disabled: '未启用' }[state] || state);
export const signedClass = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'muted' : value < 0 ? 'negative' : 'positive';
export const scenarioNames = { normal: '正常成交', partial: '部分成交', 'reject-short': '空腿拒单', 'unknown-short': '空腿状态待确认', 'cancel-delay': '撤销延迟', 'cancel-reject': '首次撤销失败' };

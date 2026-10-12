import type { MonitorSummary } from './monitor-summary.ts';

export const PERPETUAL_SUMMARY_REFRESH_MS = 5_000;
export type PerpetualSummaryData = {
  schemaVersion: 1; monitorId: 'perpetual'; available: boolean;
  status: 'live' | 'partial' | 'snapshot' | 'connecting' | 'unavailable';
  state: 'online' | 'partial' | 'stale' | 'offline';
  quoteUpdatedAt: number | null; updatedAt: number | null; staleAfterMs: number;
  baseCount: number | null; quoteCount: number | null;
  exchangeCount: number | null; onlineExchangeCount: number | null; liveExchangeCount: number | null;
  message: string;
};

export function unavailablePerpetualSummary(): PerpetualSummaryData {
  return { schemaVersion: 1, monitorId: 'perpetual', available: false, status: 'unavailable', state: 'offline',
    quoteUpdatedAt: null, updatedAt: null, staleAfterMs: 30_000, baseCount: null, quoteCount: null,
    exchangeCount: null, onlineExchangeCount: null, liveExchangeCount: null,
    message: '当前网页预览没有常驻行情后台，合约概览暂不可用。' };
}

export function parsePerpetualSummary(value: unknown): PerpetualSummaryData {
  const data = value as PerpetualSummaryData | null;
  const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const timestamp = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8.64e15;
  if (!data || data.schemaVersion !== 1 || data.monitorId !== 'perpetual' || typeof data.available !== 'boolean'
    || !['live', 'partial', 'snapshot', 'connecting', 'unavailable'].includes(data.status)
    || !['online', 'partial', 'stale', 'offline'].includes(data.state)
    || !Number.isFinite(data.staleAfterMs) || data.staleAfterMs <= 0 || !timestamp(data.quoteUpdatedAt) || !timestamp(data.updatedAt)
    || typeof data.message !== 'string'
    || [data.baseCount, data.quoteCount, data.exchangeCount, data.onlineExchangeCount, data.liveExchangeCount].some(value => !(value === null && !data.available) && !count(value))
    || data.onlineExchangeCount !== null && data.exchangeCount !== null && data.onlineExchangeCount > data.exchangeCount
    || data.baseCount !== null && data.quoteCount !== null && data.baseCount > data.quoteCount) throw new Error('合约概览响应无效');
  return data;
}

export async function readPerpetualSummary(signal: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl('/api/monitors/perpetual/summary', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('合约概览更新失败');
  return parsePerpetualSummary(await response.json());
}

export function failedPerpetualSummary(previous: MonitorSummary): MonitorSummary {
  return { ...previous, status: previous.fetchedAt ? 'stale' : 'error', note: '合约概览更新失败 · 保留上次数据，稍后自动重试' };
}

export function perpetualMonitorSummary(data: PerpetualSummaryData | null = null, previous?: MonitorSummary, now = Date.now()): MonitorSummary {
  const empty: MonitorSummary = { status: 'loading', fetchedAt: null,
    metrics: [{ label: '覆盖币种', value: '—' }, { label: '实时平台', value: '—' }], note: 'CEX / DEX 永续合约 · 买卖盘口价差' };
  if (!data) return empty;
  if (!data.available || data.status === 'unavailable') return { ...(previous ?? empty), status: 'error', staleAfterMs: data.staleAfterMs, note: data.message || '合约采集服务未就绪' };
  const hasQuotes = data.quoteCount !== null && data.quoteCount > 0;
  const stale = data.status === 'snapshot' || hasQuotes && (data.quoteUpdatedAt === null || now - data.quoteUpdatedAt > data.staleAfterMs);
  const partial = data.status === 'partial' ? '部分平台在线' : data.state === 'partial' || data.state === 'stale' ? '部分盘口待更新' : '';
  return { status: stale ? 'stale' : data.status === 'connecting' || !hasQuotes ? 'loading' : 'live',
    fetchedAt: data.quoteUpdatedAt === null ? null : new Date(data.quoteUpdatedAt).toISOString(), staleAfterMs: data.staleAfterMs,
    metrics: [{ label: '覆盖币种', value: hasQuotes && data.baseCount !== null ? String(data.baseCount) : '—' },
      { label: stale ? '上次在线' : '实时平台', value: hasQuotes && data.onlineExchangeCount !== null && data.exchangeCount !== null ? `${data.onlineExchangeCount} / ${data.exchangeCount}` : '—' }],
    note: [partial, data.message].filter(Boolean).join(' · ') || empty.note };
}

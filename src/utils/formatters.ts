import type { Metric } from '../types';

export function formatDate(value: string | null, full = false) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(full ? { month: '2-digit', day: '2-digit' } as const : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export function metricValue(metric?: Metric) {
  if (!metric || metric.value === null) return '—';
  return typeof metric.value === 'number'
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(metric.value)
    : metric.value;
}

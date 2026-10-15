import type { Freshness } from '@/lib/monitoring-status';
import { isDisplayTimestamp } from '@/lib/display-time';

export const monitoringDate = (value?: number | null) =>
  isDisplayTimestamp(value)
    ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false })
    : '—';

export function FreshnessIndicator({
  freshness,
  label = '采样',
}: {
  freshness: Freshness;
  label?: string;
}) {
  const age = freshness.ageSeconds;
  const elapsed =
    age === null
      ? '无有效时间'
      : age < 60
        ? `${Math.floor(age)} 秒前`
        : age < 3600
          ? `${Math.floor(age / 60)} 分钟前`
          : `${Math.floor(age / 3600)} 小时前`;
  return (
    <span
      className={`freshness-indicator freshness-${freshness.status}`}
      title={`${label}：${monitoringDate(freshness.timestamp)}；有效期 ${freshness.thresholdSeconds} 秒`}
    >
      <i aria-hidden="true" />
      {label} {elapsed}
      {freshness.status === 'stale' ? '（过期）' : ''}
    </span>
  );
}

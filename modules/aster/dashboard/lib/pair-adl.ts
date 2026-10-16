import type { Pair } from './pairs';
import type { State } from './desk-types';
import { notificationChannel } from './notification-channels.ts';

export type AdlConfig = { enabled: boolean; batch_notional: string };
export type PairAdlState = {
  monitoring: {
    status: 'waiting' | 'monitoring' | 'degraded' | 'inactive';
    reason: string;
    checked_at: number | null;
  };
  incident: {
    id: string;
    status: 'active' | 'blocked' | 'completed';
    hold: boolean;
    halted: boolean;
    reason: string;
    symbols: string[];
    created_at: number;
    completed_at: number | null;
    batch_count: number;
    config: AdlConfig;
  } | null;
  report_available: boolean;
  pending_event?: boolean;
  configuration_locked: boolean;
  lock_reason: string;
  margin_only_switch_allowed?: boolean;
};

export type AdlReport = {
  pair_id: string;
  incident_id: string;
  status: string;
  generated_at: number;
  messages: string[];
};

export function parseAdlConfig(enabled: boolean, value: string): AdlConfig {
  const text = value.trim();
  if (typeof enabled !== 'boolean') throw new Error('ADL 自动减仓开关无效');
  if (text.length > 40 || !/^[0-9]+(?:\.[0-9]+)?$/.test(text))
    throw new Error('ADL 单批金额须为最多 40 个字符的普通十进制数');
  const [whole, fraction = ''] = text.split('.');
  const units = BigInt(whole + fraction);
  const scale = BigInt(10) ** BigInt(fraction.length);
  if (units < scale || units > BigInt(1000000) * scale)
    throw new Error('ADL 单批金额须在 1–1000000 之间');
  return { enabled, batch_notional: text };
}

export function adlConfigurationLock(pair: Pair): string {
  const state = pair.state?.adl;
  const incident = state?.incident;
  if (
    state?.configuration_locked ||
    (incident && (incident.status !== 'completed' || incident.hold))
  )
    return (
      state?.lock_reason || 'ADL 处理中或完成后保持暂停观察，暂不能修改设置。'
    );
  return '';
}

export function adlStartBlock(pair: Pair): string {
  if (pair.state?.adl?.pending_event) return '已收到 ADL 事件，等待确认现场。';
  const incident = pair.state?.adl?.incident;
  return incident && incident.status !== 'completed'
    ? 'ADL 处理尚未完成，请先查看处理状态和报告。'
    : '';
}

export function adlRecoveryBlock(pair: Pair): boolean {
  const state = pair.state?.adl;
  const incident = state?.incident;
  return Boolean(
    state?.pending_event ||
    (incident && (incident.status !== 'completed' || incident.hold)),
  );
}

export function adlStatus(state: PairAdlState | undefined, offline = false) {
  if (offline) return { label: '连接中断 · 最近记录', attention: true };
  const incident = state?.incident;
  if (incident?.status === 'active')
    return { label: '正在处理 ADL', attention: true };
  if (incident?.status === 'blocked')
    return { label: 'ADL 处理受阻', attention: true };
  if (state?.pending_event)
    return { label: '已收到 ADL · 等待核实', attention: true };
  if (incident?.status === 'completed')
    return {
      label: incident.hold ? '处理完成 · 保持暂停' : '最近处理已完成',
      attention: false,
    };
  if (!state?.monitoring) return { label: '等待 ADL 状态', attention: true };
  const labels = {
    waiting: '等待首次检查',
    monitoring: '定期补查正常',
    degraded: '监测检查受阻',
    inactive: '监测未生效',
  };
  return {
    label: labels[state.monitoring.status],
    attention: state.monitoring.status !== 'monitoring',
  };
}

export function adlNotificationStatus(
  notification?: State['notification'],
  enabled?: boolean,
): string {
  if (enabled === false || notification?.enabled === false)
    return '飞书通知总开关已关闭';
  if (!notification) return '飞书状态尚未提供';
  const channel = notificationChannel(notification, 'event');
  if (channel.error) return `飞书事件通知异常：${channel.error}`;
  return channel.configured ? '飞书事件机器人已配置' : '飞书事件机器人未配置';
}

export function parseAdlReport(
  value: unknown,
  pairId: string,
  incidentId: string,
): AdlReport {
  if (!value || typeof value !== 'object') throw new Error('ADL 报告格式无效');
  const report = value as Partial<AdlReport>;
  if (report.pair_id !== pairId || report.incident_id !== incidentId)
    throw new Error('ADL 事件已变化，请重新读取报告');
  if (
    !['active', 'blocked', 'completed'].includes(report.status ?? '') ||
    typeof report.generated_at !== 'number' ||
    !Number.isFinite(report.generated_at) ||
    report.generated_at <= 0 ||
    !Array.isArray(report.messages) ||
    !report.messages.length ||
    report.messages.some(
      (message) => typeof message !== 'string' || !message.trim(),
    )
  )
    throw new Error('ADL 报告不完整，请重试');
  return report as AdlReport;
}

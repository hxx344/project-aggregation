import type { SymbolMonitorStatus } from '@/lib/monitoring-status';

export const symbolStatusLabels: Record<SymbolMonitorStatus, string> = {
  active: '监控中',
  stale: '数据过期',
  paused: '已暂停',
  unavailable: '非交易中',
  error: '采样失败',
};

export function SymbolStatusBadge({ status }: { status: SymbolMonitorStatus }) {
  return (
    <span className={`symbol-status symbol-status-${status}`}>
      <i aria-hidden="true" />
      {symbolStatusLabels[status]}
    </span>
  );
}

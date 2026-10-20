import { Activity, FolderKanban, Gauge, Wallet } from 'lucide-react';
import { statusText } from './check-notice';
import type { Adapter, Category, Snapshot } from './types';

export const groupLabels: Record<Category, string> = { trading: '交易', monitoring: '监控', assets: '资产', other: '其他' };

export function ProjectIcon({ category, size = 22 }: { category: Category; size?: number }) {
  return category === 'assets' ? <Wallet size={size} /> : category === 'monitoring' ? <Activity size={size} /> : category === 'trading' ? <Gauge size={size} /> : <FolderKanban size={size} />;
}

export function Status({ state, adapter, diagnostics }: { state: Snapshot['state']; adapter?: Adapter; diagnostics?: Snapshot['diagnostics'] }) {
  if (adapter === 'link' && state === 'online') return <span className="status unconfigured">网页入口</span>;
  if (state === 'partial' && diagnostics?.length && diagnostics.every(issue => issue.kind === 'notice')) return <span className="status unconfigured"><span aria-hidden="true" />运行提示</span>;
  return <span className={`status ${state}`}><span aria-hidden="true" />{statusText[state]}</span>;
}

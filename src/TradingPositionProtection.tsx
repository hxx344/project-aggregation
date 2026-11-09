import type { ProtectionStatus } from './trading-anthropic-protection-types';
import { beijingTime } from './trading-format';

const LABELS: Record<ProtectionStatus['state'], string> = {
  ready: '最近核验通过', monitoring: '规则监测中', disabled: '未启用', blocked: '暂不可执行', unknown: '待核验', unconfigured: '未配置',
  unmatched: '未覆盖', running: '减仓执行中', pending: '等待核验', stale: '证据已过期',
};

export default function TradingPositionProtection({ value, kind, now, unavailable }: { value?: ProtectionStatus; kind: 'alert' | 'reduction'; now: number; unavailable: boolean }) {
  const until = Date.parse(value?.validUntil ?? '');
  const expired = (value?.state === 'ready' || value?.state === 'monitoring') && (!Number.isFinite(until) || !Number.isFinite(now) || now >= until);
  const monitoring = kind === 'reduction' && value?.state === 'ready' && expired && Number.isFinite(now) && Date.parse(value.monitorUntil ?? '') > now;
  const state = unavailable || !value ? 'unknown' : monitoring ? 'monitoring' : expired ? 'stale' : value.state;
  const label = state === 'ready' && kind === 'alert' ? '预警监测中' : state === 'blocked' && kind === 'alert' ? '暂无法监测' : LABELS[state];
  const reason = unavailable ? '读取中断或设置正在变化，等待重新确认' : !value ? '暂未取得覆盖结果' : monitoring ? '规则持续监测；上次行情已到期，下单前会重新核验' : expired ? '来源证据已过期，等待下一次核验' : value.reason;
  return <div className={`trading-position-protection ${state}`} data-protection-kind={kind} data-protection-state={state}>
    <strong>{label}</strong><span>{reason}</span>
    <small>{value?.checkedAt ? `上次${kind === 'alert' ? '读取' : '检查'} ${beijingTime(value.checkedAt)}` : '尚无检查时间'}</small>
  </div>;
}

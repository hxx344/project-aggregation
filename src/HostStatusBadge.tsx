import { useRef } from 'react';
import { Server } from 'lucide-react';
import { formatBytes, formatUptime, hostLevel } from './server-status-types';
import type { HostStatus } from './server-status-types';
import { useLiveResource } from './use-live-resource';

const POLL_MS = 15_000;
const pct = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value)}%`;
const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

// Compact server load next to the connection status.
export default function HostStatusBadge({ onOpen, onExpired }: { onOpen: () => void; onExpired: () => void }) {
  const details = useRef<HTMLDetailsElement>(null);
  // 与服务器状态页共享同一份读取：页面打开时按 5 秒间隔，平时 15 秒，后台暂停。
  const host = useLiveResource<HostStatus>('/api/system/host', { intervalMs: POLL_MS, onExpired });
  // 失败标记保留到下一次读取成功，重试期间仍提示显示的是旧数据。
  const status = host.data, failed = !!host.error;
  // On narrow screens both topbar panels anchor to the same corner: opening one closes the other.
  const toggle = () => { if (details.current?.open) details.current.closest('.topbar-right')?.querySelectorAll('details[open]').forEach(other => { if (other !== details.current) (other as HTMLDetailsElement).open = false; }); };
  const disk = (status?.disks ?? []).reduce<number | null>((worst, item) => item.usedPercent == null ? worst : Math.max(worst ?? 0, item.usedPercent), null);
  const diskError = !!status?.disks.some(item => item.error);
  const cpu = status?.cpu.usagePercent, memory = status?.memory.usedPercent;
  const metrics: [string, number | null | undefined][] = [['CPU', cpu], ['内存', memory], ['磁盘', disk]];
  const [worstKey, worst] = metrics.reduce<[string, number | null]>((max, [key, value]) => value != null && (max[1] === null || value > max[1]) ? [key, value] : max, ['', null]);
  const tone = failed && !status ? 'alert' : hostLevel(worst);
  const diskTone = hostLevel(disk) || (diskError ? 'warn' : '');
  const label = status ? `服务器负载：CPU ${pct(cpu)}，内存 ${pct(memory)}，磁盘 ${pct(disk)}${diskError ? '，有磁盘无法读取' : ''}${failed ? '，最近一次读取失败，显示的是旧数据' : ''}` : failed ? '服务器负载：读取失败' : '服务器负载：读取中';
  return <details ref={details} className={`connection-status host-status ${tone} ${failed && status ? 'stale' : ''}`} onToggle={toggle}>
    <summary aria-label={label}>
      <Server size={15} aria-hidden="true" />
      {status ? <>
        <span className={`host-metric ${hostLevel(cpu)}`}><span className="host-key">CPU</span><span className="host-num">{pct(cpu)}</span></span>
        <span className={`host-metric ${hostLevel(memory)}`}><span className="host-key">内存</span><span className="host-num">{pct(memory)}</span></span>
        <span className={`host-metric ${diskTone}`}><span className="host-key">磁盘</span><span className="host-num">{pct(disk)}</span></span>
        <span className={`host-worst ${hostLevel(worst)}`}><span className="host-key">{worstKey}</span><span className="host-num">{pct(worst)}</span></span>
        {failed ? <span className="host-stale" aria-hidden="true">!</span> : null}
      </> : <span>{failed ? '读取失败' : '读取中'}</span>}
    </summary>
    <div className="connection-details">
      <strong>服务器状态</strong>
      {status ? <>
        <p>CPU {pct(cpu)} · {status.cpu.cores} 核 · 负载 {status.cpu.loadAverage.map(value => value.toFixed(2)).join(' / ')}</p>
        <p>内存 {formatBytes(status.memory.usedBytes)} / {formatBytes(status.memory.totalBytes)}，可用 {formatBytes(status.memory.availableBytes)}</p>
        {status.disks.map(item => <p key={item.id}>{item.label}：{item.error ? item.error : `剩余 ${formatBytes(item.availableBytes)} / ${formatBytes(item.totalBytes)}（已用 ${pct(item.usedPercent)}）`}</p>)}
        <p>已运行 {formatUptime(status.uptimeSeconds)}</p>
      </> : null}
      {failed ? <p className="connection-problem">最近一次读取失败，{status ? '显示的是上次读到的数据，' : ''}将自动重试。</p> : null}
      <p>占用 ≥75% 显示黄色，≥90% 显示红色；前台每 15 秒更新，后台暂停。</p>
      <button type="button" className="host-open" onClick={() => { if (details.current) details.current.open = false; onOpen(); }}>查看详情</button>
      {status ? <small>读取于 {time(status.generatedAt)}</small> : null}
    </div>
  </details>;
}

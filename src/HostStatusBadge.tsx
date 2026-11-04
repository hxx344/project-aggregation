import { useEffect, useRef, useState } from 'react';
import { Server } from 'lucide-react';
import { api } from './api';
import { formatBytes, formatUptime, hostLevel } from './server-status-types';
import type { HostStatus } from './server-status-types';

const POLL_MS = 15_000;
const pct = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value)}%`;
const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

// Compact server load next to the connection status; polls only while the page is visible.
export default function HostStatusBadge({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const read = async () => {
      if (busy || document.hidden || controller.signal.aborted) return;
      busy = true;
      try { const data = await api<HostStatus>('/api/system/host', { signal: controller.signal, timeoutMs: 10_000 }); if (!controller.signal.aborted) { setStatus(data); setFailed(false); } }
      catch { if (!controller.signal.aborted) setFailed(true); }
      finally { busy = false; }
    };
    void read();
    const poll = setInterval(() => void read(), POLL_MS);
    const visible = () => void read();
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearInterval(poll); document.removeEventListener('visibilitychange', visible); };
  }, []);
  const disks = status?.disks.filter(disk => !disk.error) ?? [];
  const disk = disks.reduce<number | null>((worst, item) => item.usedPercent == null ? worst : Math.max(worst ?? 0, item.usedPercent), null);
  const cpu = status?.cpu.usagePercent, memory = status?.memory.usedPercent;
  const worst = [cpu, memory, disk].reduce<number | null>((max, value) => value == null ? max : Math.max(max ?? 0, value), null);
  const tone = failed && !status ? 'alert' : hostLevel(worst);
  const label = status ? `服务器负载：CPU ${pct(cpu)}，内存 ${pct(memory)}，磁盘 ${pct(disk)}${failed ? '，最近一次读取失败' : ''}` : failed ? '服务器负载：读取失败' : '服务器负载：读取中';
  return <details ref={details} className={`connection-status host-status ${tone}`}>
    <summary aria-label={label}>
      <Server size={15} aria-hidden="true" />
      {status ? <>
        <span className={`host-metric ${hostLevel(cpu)}`}><span className="host-key">CPU</span>{pct(cpu)}</span>
        <span className={`host-metric ${hostLevel(memory)}`}><span className="host-key">内存</span>{pct(memory)}</span>
        <span className={`host-metric ${hostLevel(disk)}`}><span className="host-key">磁盘</span>{pct(disk)}</span>
        <span className={`host-worst ${tone}`}>{pct(worst)}</span>
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

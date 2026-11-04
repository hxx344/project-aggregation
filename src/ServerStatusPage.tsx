import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, Clock, Cpu, HardDrive, LoaderCircle, MemoryStick, RefreshCw } from 'lucide-react';
import { api, ApiError } from './api';
import type { HostStatus } from './server-status-types';
import './aero-lp.css';
import './server-status.css';

const POLL_MS = 5_000;
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const bootTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败，请重试。';
const level = (value: number | null | undefined) => value == null ? '' : value >= 90 ? 'alert' : value >= 75 ? 'warn' : '';
function formatBytes(bytes: number | undefined) {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function Card({ icon, title, percent, suffix, children }: { icon: ReactNode; title: string; percent: number | null | undefined; suffix?: string; children: ReactNode }) {
  const tone = level(percent);
  return <section className={`panel ss-card ${tone}`} aria-label={title}>
    <div className="ss-title">{icon}{title}</div>
    <div className="ss-value">{percent == null ? '—' : `${percent.toFixed(1)}%`}{suffix ? <small>{suffix}</small> : null}</div>
    <div className={`ss-meter ${tone}`} role="meter" aria-label={`${title}占用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><span style={{ width: `${percent ?? 0}%` }} /></div>
    <dl className="ss-details">{children}</dl>
  </section>;
}
const Row = ({ label, value }: { label: string; value: ReactNode }) => <><dt>{label}</dt><dd>{value}</dd></>;

export default function ServerStatusPage({ onExpired }: { onExpired: () => void }) {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  // Bound to the lifetime that started it, so a remount (StrictMode) is not blocked by the aborted read.
  const inFlight = useRef<AbortSignal | null>(null);
  const read = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || inFlight.current === signal) return;
    inFlight.current = signal; setLoading(true);
    try { const data = await api<HostStatus>('/api/system/host', { signal, timeoutMs: 10_000 }); if (!signal.aborted) { setStatus(data); setError(''); } }
    catch (reason) { if (!signal.aborted) { if (reason instanceof ApiError && reason.status === 401) onExpired(); else setError(message(reason)); } }
    finally { if (inFlight.current === signal) inFlight.current = null; if (!signal.aborted) setLoading(false); }
  }, [onExpired]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void read();
    const poll = setInterval(() => { if (!document.hidden) void read(); }, POLL_MS);
    const visible = () => { if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearInterval(poll); document.removeEventListener('visibilitychange', visible); };
  }, [read]);

  const swap = status?.memory.swap;
  return <div className="lp-page">
    <header className="lp-heading"><div><h1>服务器状态</h1><p>工作台所在服务器的 CPU、内存与磁盘，页面打开时每 5 秒刷新</p></div><div className="lp-toolbar">
      {status ? <span className="ss-meta">读取于 {time.format(Date.parse(status.generatedAt))}</span> : null}
      <button className="button secondary" disabled={loading} onClick={() => void read()}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button>
    </div></header>
    {error ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>状态读取失败：{error}。{status ? '下面是最后一次读取的数据，' : ''}稍后自动重试。</span></div> : null}
    {!status ? error ? null : <section className="panel lp-empty" role="status"><LoaderCircle className="spin" /><strong>正在读取服务器状态</strong></section> : <div className="ss-grid">
      <Card icon={<Cpu size={16} />} title="CPU" percent={status.cpu.usagePercent} suffix={`${status.cpu.cores} 核`}>
        <Row label="负载（1/5/15 分钟）" value={status.cpu.loadAverage.map(value => value.toFixed(2)).join(' / ')} />
        {status.cpu.model ? <Row label="型号" value={status.cpu.model} /> : null}
      </Card>
      <Card icon={<MemoryStick size={16} />} title="内存" percent={status.memory.usedPercent}>
        <Row label="已用 / 总量" value={`${formatBytes(status.memory.usedBytes)} / ${formatBytes(status.memory.totalBytes)}`} />
        <Row label="可用" value={formatBytes(status.memory.availableBytes)} />
        {swap ? <Row label="交换分区" value={swap.totalBytes ? `${formatBytes(swap.usedBytes)} / ${formatBytes(swap.totalBytes)}` : '未启用'} /> : null}
      </Card>
      {status.disks.map(disk => disk.error ? <section key={disk.id} className="panel ss-card" aria-label={disk.label}><div className="ss-title"><HardDrive size={16} />{disk.label}</div><span className="ss-unavailable">{disk.error}</span></section>
        : <Card key={disk.id} icon={<HardDrive size={16} />} title={disk.label} percent={disk.usedPercent} suffix={`已用 · 剩余 ${formatBytes(disk.availableBytes)}`}>
          <Row label="已用 / 总量" value={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`} />
        </Card>)}
      <section className="panel ss-card" aria-label="运行时间"><div className="ss-title"><Clock size={16} />运行时间</div>
        <div className="ss-value">{formatUptime(status.uptimeSeconds)}</div>
        <dl className="ss-details"><Row label="开机于" value={bootTime.format(Date.parse(status.generatedAt) - status.uptimeSeconds * 1000)} /></dl>
      </section>
    </div>}
  </div>;
}

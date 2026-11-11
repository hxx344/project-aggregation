import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, Clock, Cpu, HardDrive, MemoryStick, RefreshCw } from 'lucide-react';
import { api, ApiError } from './api';
import type { EventLoopStatus, HostStatus } from './server-status-types';
import { formatBytes, formatUptime, hostLevel, lagLevel } from './server-status-types';
import './server-status.css';
import { Callout, StatePanel } from './StateViews';

const POLL_MS = 5_000;
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const bootTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败，请重试。';
const level = hostLevel;

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
const ms = (value: number | null) => value == null ? '—' : `${value.toLocaleString('zh-CN')} ms`;

function EventLoopCard({ status, error }: { status: EventLoopStatus | null; error: string }) {
  const title = '数据面卡顿';
  const stallMs = status?.stallThresholdMs ?? 200;
  const tone = lagLevel(status?.lastMinute.maxMs, stallMs);
  return <section className={`panel ss-card ${tone}`} aria-label={title}>
    <div className="ss-title"><Activity size={16} />{title}</div>
    {!status ? <span className="ss-unavailable">{error ? `读取失败：${error}` : '正在读取'}</span> : <>
      <div className="ss-value">{ms(status.lastMinute.maxMs)}<small>最近 1 分钟最大</small></div>
      <dl className="ss-details">
        <Row label="最近 5 分钟最大" value={ms(status.lastFiveMinutes.maxMs)} />
        <Row label={`最近 5 分钟 ≥ ${stallMs} ms`} value={`${status.lastFiveMinutes.stalls} 次`} />
        {status.recentStalls.slice(0, 3).map(stall => <Row key={stall.endedAt + stall.durationMs} label={`${time.format(Date.parse(stall.endedAt))} 结束`} value={ms(stall.durationMs)} />)}
      </dl>
      <p className="ss-note">采集、行情 WS 与研究共用数据面一个线程，卡顿期间收到的行情和请求都要排队。{error ? `最新读取失败：${error}，显示上次结果。` : ''}</p>
    </>}
  </section>;
}

export default function ServerStatusPage({ onExpired }: { onExpired: () => void }) {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [error, setError] = useState('');
  const [loop, setLoop] = useState<EventLoopStatus | null>(null);
  const [loopError, setLoopError] = useState('');
  const [loading, setLoading] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  // Bound to the lifetime that started it, so a remount (StrictMode) is not blocked by the aborted read.
  const inFlight = useRef<Record<'host' | 'loop', AbortSignal | null>>({ host: null, loop: null });
  const read = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    // Independent reads: the control plane answers host status itself, the data
    // plane answers the event loop, and a stalled data plane must not hold the host cards back.
    async function one<T>(key: 'host' | 'loop', path: string, apply: (data: T) => void, fail: (text: string) => void) {
      if (!signal || inFlight.current[key] === signal) return;
      inFlight.current[key] = signal; if (key === 'host') setLoading(true);
      try { const data = await api<T>(path, { signal, timeoutMs: 10_000 }); if (!signal.aborted) apply(data); }
      catch (reason) { if (!signal.aborted) { if (reason instanceof ApiError && reason.status === 401) onExpired(); else fail(message(reason)); } }
      finally { if (inFlight.current[key] === signal) inFlight.current[key] = null; if (key === 'host' && !signal.aborted) setLoading(false); }
    }
    await Promise.all([
      one<HostStatus>('host', '/api/system/host', data => { setStatus(data); setError(''); }, setError),
      one<EventLoopStatus>('loop', '/api/system/event-loop', data => { setLoop(data); setLoopError(''); }, setLoopError),
    ]);
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
  return <div className="wb-page">
    <header className="wb-heading"><div><h1>服务器状态</h1><p>工作台所在服务器的 CPU、内存、磁盘与数据面卡顿，页面打开时每 5 秒刷新</p></div><div className="wb-toolbar">
      {status ? <span className="ss-meta">读取于 {time.format(Date.parse(status.generatedAt))}</span> : null}
      <button className="button secondary" disabled={loading} onClick={() => void read()}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button>
    </div></header>
    {error ? <Callout tone="warning">状态读取失败：{error}。{status ? '下面是最后一次读取的数据，' : ''}稍后自动重试。</Callout> : null}
    {!status ? <>{error ? null : <StatePanel kind="loading" title="正在读取服务器状态" />}
      {loop ? <div className="ss-grid"><EventLoopCard status={loop} error={loopError} /></div> : null}</> : <div className="ss-grid">
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
      <EventLoopCard status={loop} error={loopError} />
      <section className="panel ss-card" aria-label="运行时间"><div className="ss-title"><Clock size={16} />运行时间</div>
        <div className="ss-value">{formatUptime(status.uptimeSeconds)}</div>
        <dl className="ss-details"><Row label="开机于" value={bootTime.format(Date.parse(status.generatedAt) - status.uptimeSeconds * 1000)} /></dl>
      </section>
    </div>}
  </div>;
}

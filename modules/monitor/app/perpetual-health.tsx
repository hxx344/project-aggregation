"use client";

import { memo, useEffect, useState } from 'react';
import { ChevronDown, Activity } from 'lucide-react';
import { startActivityPolling } from '../lib/polling';
import { venueHealthReason, type PerpetualDiagnostics } from '../lib/perpetual-health';
import './perpetual-health.css';

const stamp = (value: number | null | undefined) => value ? new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const value = (number: number | null | undefined, suffix = '') => typeof number === 'number' && Number.isFinite(number) ? `${number.toFixed(1)}${suffix}` : '—';

function PerpetualHealth({ active = true, defaultOpen = false }: { active?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen), [data, setData] = useState<PerpetualDiagnostics | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!active || !open) return;
    const polling = startActivityPolling({ intervalMs: 5_000, load: async signal => {
      const response = await fetch('/api/monitors/perpetual/diagnostics', { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      if (!response.ok) throw new Error('报价健康后台未连接');
      const result = await response.json() as PerpetualDiagnostics;
      if (!Number.isFinite(result.generatedAt) || !Array.isArray(result.venues)) throw new Error('诊断资料格式异常');
      return result;
    }, onData: result => { setData(result); setError(''); }, onError: () => setError('诊断更新失败，保留上次资料。请检查 Linux 后台连接。') });
    return () => polling.stop();
  }, [active, open]);
  return <section className="perp-diagnostics" aria-label="合约报价健康">
    <button type="button" className="perp-diagnostics-heading" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="perp-diagnostics-body"><span><Activity size={17}/><strong>报价健康</strong><small>{data ? `${data.venues.filter(venue => venue.status === 'live').length} / ${data.venues.length} 平台在线` : '按需诊断'}</small></span><ChevronDown size={16}/></button>
    {open ? <div id="perp-diagnostics-body" className="perp-diagnostics-body">
      <p className="perp-diagnostics-caption">{data ? `诊断时间 ${stamp(data.generatedAt)} 北京时间` : '正在读取后台指标'} · 每 5 秒更新，收起或隐藏页面即暂停。盘口有效率以已发现合约为分母。</p>
      {data?.collection ? <p className="perp-diagnostics-caption">官方接口直连 · 行情观测 {data.collection.observationIntervalMs / 1000} 秒 · 成交额 / 持仓量目标 {data.collection.marketMetricsIntervalMs / 1000} 秒 · 合约目录 {data.collection.discoveryIntervalMs / 60000} 分钟 · 非活跃盘口补查 {data.collection.auxiliaryBookIntervalMs / 1000} 秒。必要的快速盘口确认保留，限流时排队；来源时间不会因采样而更新。</p> : null}
      {error ? <p role="status" className="perp-diagnostics-warning">{error}</p> : null}
      {data ? <><div className="perp-diagnostics-metrics">{[
        ['CPU', value(data.cpuPercent, '%')], ['进程内存', value(data.rssMb, ' MiB')], ['事件循环 P99', value(data.eventLoopP99Ms, ' ms')], ['行情消息', `${data.messagesPerSecond} / 秒`], ['广播耗时', value(data.lastPublishMs, ' ms')], ['最近写盘', value(data.lastWriteMs, ' ms')],
      ].map(([label, text]) => <div key={label}><small>{label}</small><strong>{text}</strong></div>)}</div>
        <p className="perp-diagnostics-caption">CPU 为本进程消耗，单核满载约 100%，双核约 200%。待写 {data.pendingWrites} 条 · 行情 {data.quotes} 条 · 本轮增量检查 {data.lastPatchVisitedQuotes ?? '—'} 条。</p>
        {data.storageError ? <p className="perp-diagnostics-warning">{data.storageError}</p> : null}
        {data.eventLoopP99Ms > 80 ? <p className="perp-diagnostics-warning">服务处理存在明显等待，可能影响报价到达速度；请先检查 CPU 和写盘耗时。</p> : null}
        <div className="perp-diagnostics-venues">{data.venues.map(venue => <article key={venue.id}>
          <div className="perp-diagnostics-venue-title"><strong>{venue.name} <small>{venue.status === 'live' ? '在线' : '未在线'}</small></strong><span>{venue.marketCount ? `${Math.min(100, (venue.freshBookCount ?? 0) / venue.marketCount * 100).toFixed(0)}% 盘口在时效内` : '目录待就绪'}</span></div>
          <dl><div><dt>有效 / 过期 / 无盘口</dt><dd>{venue.freshBookCount ?? 0} / {venue.staleBookCount ?? 0} / {Math.max(venue.missingBookCount ?? 0, venue.marketCount - (venue.freshBookCount ?? 0) - (venue.staleBookCount ?? 0))}</dd></div><div><dt>最近源延迟</dt><dd>{value(venue.sourceLagMs, ' ms')}<small>测于 {stamp(venue.sourceLagObservedAt)}</small></dd></div><div><dt>有效行情到达</dt><dd>{stamp(venue.lastMessageAt)}</dd></div><div><dt>重连 / 时钟拒绝</dt><dd>{venue.reconnects ?? 0} / {venue.rejectedFuture ?? 0}</dd></div></dl>
          <p>{venueHealthReason(venue, data.generatedAt)}</p>
        </article>)}</div>
        <details className="perp-diagnostics-events"><summary>最近连接事件（近 1 小时，最多 60 条）</summary>{data.events?.length ? data.events.map(event => <p key={event.id}><time>{stamp(event.at)}</time> {data.venues.find(venue => venue.id === event.exchange)?.name ?? event.exchange} · {event.reason}</p>) : <p>尚无事件记录。</p>}</details>
      </> : null}
    </div> : null}
  </section>;
}
export default memo(PerpetualHealth);

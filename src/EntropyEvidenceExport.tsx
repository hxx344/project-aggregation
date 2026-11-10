import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from './api';
import type { LabSymbol } from './entropy-lighter-types';

type Evidence = { jsonl: string; manifest: { gaps: string[]; output: { records: number; rawFrames: number; normalizedEvents: number }; scan: { bytes: number }; [key: string]: unknown } };
const localTime = (millis: number) => {
  const date = new Date(millis); return new Date(millis - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
};
const gapLabels: Record<string, string> = {
  raw_recording_disabled: '该会话未启用原始帧记录', raw_recording_state_unknown: '无法确认原始帧记录开关',
  session_logs_absent_or_cleaned: '会话日志不存在或已清理', segments_missing_or_cleaned: '部分分段已缺失或清理',
  session_start_absent_or_cleaned: '会话起始记录缺失', window_outside_retained_observations: '时间窗超出已读取观测范围',
  bad_lines: '包含坏行', partial_line: '存在未完成行', raw_symbol_unresolved_or_unsupported: '部分原始帧无法确认标的或格式',
  events_without_wall_time: '部分旧事件没有墙上时钟', segment_changed_during_read: '读取时日志仍有追加',
};

export default function EntropyEvidenceExport({ session, symbol, onExpired }: { session: string; symbol: LabSymbol; onExpired: () => void }) {
  const [selectedSession, setSession] = useState(session), [from, setFrom] = useState(() => localTime(Date.now() - 300_000));
  const [to, setTo] = useState(() => localTime(Date.now())), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [bundle, setBundle] = useState<{ result: Evidence; eventsUrl: string; manifestUrl: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => () => { if (bundle) { URL.revokeObjectURL(bundle.eventsUrl); URL.revokeObjectURL(bundle.manifestUrl); } }, [bundle]);
  const exportSelected = async (event: FormEvent) => {
    event.preventDefault(); if (request.current) return;
    const start = Date.parse(from), end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86_400_000) { setError('请选择开始、结束时间，最多 24 小时。'); return; }
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(''); setBundle(null);
    try {
      const params = new URLSearchParams({ session: selectedSession, symbol, from: String(start), to: String(end) });
      const result = await api<Evidence>(`/api/research/entropy-lighter/evidence?${params}`, { signal: controller.signal, timeoutMs: 10_000 });
      if (controller.signal.aborted) return;
      setBundle({ result, eventsUrl: URL.createObjectURL(new Blob([result.jsonl], { type: 'application/x-ndjson' })),
        manifestUrl: URL.createObjectURL(new Blob([JSON.stringify(result.manifest, null, 2)], { type: 'application/json' })) });
    } catch (reason) {
      if (!controller.signal.aborted) { if (reason instanceof ApiError && reason.status === 401) onExpired(); else setError(reason instanceof Error ? reason.message : '证据导出失败'); }
    } finally { request.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  return <section className="panel" aria-label="研究证据导出"><h3>研究证据片段</h3>
    <p>按会话、当前标的 {symbol} 与时间窗读取已有记录。最多 24 小时、10,000 条、4 MiB；不补采历史。时间使用本机时区，结束时间不包含在内。</p>
    <form onSubmit={event => void exportSelected(event)} className="el-toolbar">
      <label>会话<input aria-label="导出会话" value={selectedSession} onChange={event => { setSession(event.target.value); setBundle(null); }} disabled={busy} required /></label>
      <label>开始<input aria-label="导出开始" type="datetime-local" step="1" value={from} onChange={event => { setFrom(event.target.value); setBundle(null); }} disabled={busy} required /></label>
      <label>结束<input aria-label="导出结束" type="datetime-local" step="1" value={to} onChange={event => { setTo(event.target.value); setBundle(null); }} disabled={busy} required /></label>
      <button className="button secondary" disabled={busy}>{busy ? '正在读取…' : '生成证据片段'}</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {bundle ? <div role="status"><p>已导出 {bundle.result.manifest.output.records} 条：原始帧 {bundle.result.manifest.output.rawFrames} 条，标准化事件 {bundle.result.manifest.output.normalizedEvents} 条。原始帧仅含公开行情字段，清单保留原载荷摘要；不保证交易所源数据完整。</p>
      {bundle.result.manifest.gaps.length ? <p>覆盖缺口：{bundle.result.manifest.gaps.map(gap => gapLabels[gap] || (gap.endsWith('_limit') ? `达到读取或输出上限（${gap}）` : gap)).join('；')}。</p> : null}
      <a className="button secondary" href={bundle.eventsUrl} download="entropy-evidence.jsonl">下载 JSONL</a>{' '}
      <a className="button secondary" href={bundle.manifestUrl} download="entropy-evidence-manifest.json">下载清单</a>
    </div> : null}
  </section>;
}

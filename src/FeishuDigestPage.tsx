import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { BellRing, CircleAlert, KeyRound, LoaderCircle, RefreshCw, Save, Send, Trash2 } from 'lucide-react';
import { api, ApiError } from './api';
import type { DigestConfig, DigestHistoryEntry, DigestLevel, DigestPreview, DigestSection, DigestSnapshot } from './feishu-digest-types';
import './aero-lp.css';
import './feishu-digest.css';

const ROOT = '/api/automation/feishu-digest';
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const LEVELS: Record<DigestLevel, string> = { ok: '正常', notice: '提示', idle: '未启用', warn: '需要关注', alert: '需要处理' };
const RESULTS: Record<DigestHistoryEntry['status'], string> = { sent: '已发送', skipped: '无异常，未发送', failed: '发送失败', uncertain: '结果未知' };
const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const when = (value: string | number | null) => { const ms = typeof value === 'number' ? value : value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? dates.format(ms) : '—'; };
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败，请重试。';
const timeList = (text: string) => text.split(/[\s,，、]+/).filter(Boolean);

function PreviewSection({ section }: { section: DigestSection }) {
  return <section className={`fd-preview-section ${section.level}`}>
    <h3><span className="fd-dot" aria-hidden="true" />{section.name}<small>{section.status}{section.asOf ? ` · 数据 ${when(section.asOf)}` : ''}</small></h3>
    {section.metrics.length ? <dl>{section.metrics.map(metric => <div key={metric.key}><dt>{metric.label}</dt><dd>{metric.lines?.length ? metric.lines.map(line => <span key={line}>{line}</span>) : metric.text}</dd></div>)}</dl> : null}
  </section>;
}

export default function FeishuDigestPage({ onExpired }: { onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<DigestSnapshot | null>(null);
  const [draft, setDraft] = useState<DigestConfig | null>(null);
  const [timesText, setTimesText] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const dirty = !!snapshot && !!draft && JSON.stringify(draft) !== JSON.stringify(snapshot.config);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const busyRef = useRef(false);
  busyRef.current = !!busy;
  const fail = useCallback((reason: unknown, show: (text: string) => void) => { if (reason instanceof ApiError && reason.status === 401) onExpired(); else show(message(reason)); }, [onExpired]);
  // An unsaved draft stays; polling refreshes only the send records and channel state.
  const accept = useCallback((data: DigestSnapshot, replace: boolean) => {
    setSnapshot(data); setLoadError('');
    if (replace || !dirtyRef.current) { setDraft(data.config); setTimesText(data.config.schedule.times.join(', ')); }
  }, []);
  const read = useCallback(async () => {
    const signal = lifetime.current?.signal, version = ++generation.current;
    if (!signal) return;
    try { const data = await api<DigestSnapshot>(ROOT, { signal, timeoutMs: 10_000 }); if (!signal.aborted && version === generation.current) accept(data, false); }
    catch (reason) { if (!signal.aborted && version === generation.current) fail(reason, setLoadError); }
  }, [accept, fail]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void read();
    const poll = setInterval(() => { if (!busyRef.current && !document.hidden) void read(); }, 30_000);
    return () => { controller.abort(); clearInterval(poll); };
  }, [read]);
  const loadPreview = useCallback(async (config: DigestConfig) => {
    const signal = lifetime.current?.signal, version = ++previewGeneration.current;
    if (!signal) return;
    setPreviewing(true);
    try {
      const data = await api<DigestPreview>(`${ROOT}/preview`, { method: 'POST', body: JSON.stringify({ config }), signal, timeoutMs: 30_000 });
      if (!signal.aborted && version === previewGeneration.current) { setPreview(data); setPreviewError(''); }
    } catch (reason) { if (!signal.aborted && version === previewGeneration.current) fail(reason, setPreviewError); }
    finally { if (!signal.aborted && version === previewGeneration.current) setPreviewing(false); }
  }, [fail]);
  useEffect(() => {
    if (!draft) return undefined;
    const timer = setTimeout(() => void loadPreview(draft), 400);
    return () => clearTimeout(timer);
  }, [draft, loadPreview]);
  const execute = async (name: string, path: string, method: string, body: unknown, done: string, replace = false) => {
    const signal = lifetime.current?.signal;
    if (!signal || busy) return null;
    setBusy(name); setActionError(''); setNotice('');
    try {
      const data = await api<DigestSnapshot>(ROOT + path, { method, body: JSON.stringify(body), signal, timeoutMs: 30_000 });
      if (signal.aborted) return null;
      accept(data, replace); setNotice(done);
      return data;
    } catch (reason) { if (!signal.aborted) fail(reason, setActionError); return null; }
    finally { if (!signal.aborted) setBusy(''); }
  };
  const change = (next: Partial<DigestConfig>) => setDraft(current => current && { ...current, ...next });
  const changeSchedule = (next: Partial<DigestConfig['schedule']>) => setDraft(current => current && { ...current, schedule: { ...current.schedule, ...next } });
  const changeSection = (id: string, next: Partial<{ enabled: boolean; hidden: string[] }>) => setDraft(current => current && { ...current, sections: { ...current.sections, [id]: { ...(current.sections[id] ?? { enabled: true, hidden: [] }), ...next } } });
  const saveChannel = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await execute('channel', '/channel', 'PUT', { webhookUrl, signingSecret }, '机器人已保存');
    if (saved) { setWebhookUrl(''); setSigningSecret(''); }
  };
  const send = async () => {
    const data = await execute('send', '/send', 'POST', {}, '');
    if (!data?.result) return;
    if (data.result.status === 'sent') setNotice('已发送到飞书');
    else setActionError(data.result.error ?? '发送未完成');
  };
  const heading = <header className="lp-heading"><div><h1>飞书汇总</h1><p>由工作台服务器定时发送，不需要打开页面；只读取各模块已有状态，不下单、不改设置</p></div><div className="lp-toolbar">
    <button className="button secondary" disabled={!!busy} onClick={() => { void read(); if (draft) void loadPreview(draft); }}><RefreshCw size={15} className={previewing ? 'spin' : ''} />刷新</button>
    <button className="button secondary" disabled={!snapshot?.channel.configured || dirty || !!busy} title={dirty ? '请先保存设置' : !snapshot?.channel.configured ? '请先保存机器人' : undefined} onClick={() => void send()}>{busy === 'send' ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}立即发送</button>
    <button className="button primary" disabled={!dirty || !!busy} onClick={() => { if (draft) void execute('save', '/config', 'PUT', { config: draft }, '设置已保存', true); }}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存设置</button>
  </div></header>;
  return <div className="lp-page">
    {heading}
    {actionError ? <div className="error-box" role="alert">{actionError}</div> : null}
    {notice ? <div className="lp-callout success" role="status">{notice}</div> : null}
    {loadError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>状态读取失败：{loadError}。保留最后读取的数据，稍后自动重试。</span></div> : null}
    {snapshot?.loadError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>{snapshot.loadError}</span></div> : null}
    {snapshot?.channel.error ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>{snapshot.channel.error}</span></div> : null}
    {!snapshot || !draft ? <section className="panel lp-empty" role="status"><LoaderCircle className="spin" /><strong>正在读取状态</strong></section> : <div className="fd-layout">
      <div className="fd-column">
        <section className="panel lp-status" aria-label="运行状态"><div className="lp-state-line"><span className={`lp-state ${draft.enabled ? 'running' : ''}`}><BellRing size={16} />{snapshot.config.enabled ? '定时发送已开启' : '定时发送已关闭'}</span>
          <span>下次发送：{snapshot.nextAt ? when(snapshot.nextAt) : '—'}</span>{dirty ? <span className="lp-paused">有未保存的修改</span> : null}</div>
          <label className="checkbox-field fd-enable"><input type="checkbox" checked={draft.enabled} onChange={e => change({ enabled: e.target.checked })} />开启定时发送</label></section>
        <section className="panel lp-section" aria-label="飞书机器人"><div className="panel-heading"><h2>飞书机器人</h2><span className="muted">{snapshot.channel.configured ? `已配置 ${snapshot.channel.host}` : '尚未配置'}</span></div>
          <form className="lp-key" onSubmit={e => void saveChannel(e)} autoComplete="off">
            <label className="lp-field wide"><span>{snapshot.channel.configured ? '更换 Webhook' : 'Webhook 地址'}</span><input type="password" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" autoComplete="off" /><small>在飞书群添加「自定义机器人」后获得；加密保存，不在页面回显，也不与 Monitor 告警共用。</small></label>
            <label className="lp-field wide"><span>签名密钥（可选）</span><input type="password" value={signingSecret} onChange={e => setSigningSecret(e.target.value)} autoComplete="new-password" /><small>机器人开启「签名校验」时填写；更换 Webhook 时需要一并重填。开启「关键词」时请把关键词写进标题。</small></label>
            <div className="lp-key-actions"><button className="button primary" type="submit" disabled={!!busy || !webhookUrl.trim()}>{busy === 'channel' ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}保存机器人</button>
              {snapshot.channel.configured ? <button type="button" className="button secondary" disabled={!!busy} onClick={() => void execute('clear', '/channel/clear', 'POST', {}, '机器人已清除，定时发送已关闭')}><Trash2 size={15} />清除</button> : null}</div>
          </form></section>
        <section className="panel lp-section" aria-label="发送时间"><div className="panel-heading"><h2>发送时间</h2></div>
          <fieldset><div className="fd-modes" role="radiogroup" aria-label="发送方式">
            <label><input type="radio" name="fd-mode" checked={draft.schedule.mode === 'times'} onChange={() => changeSchedule({ mode: 'times' })} />每天固定时间</label>
            <label><input type="radio" name="fd-mode" checked={draft.schedule.mode === 'interval'} onChange={() => changeSchedule({ mode: 'interval' })} />按固定间隔</label></div>
            <div className="lp-grid fd-grid">
              {draft.schedule.mode === 'times' ? <label className="lp-field"><span>时间（24 小时制）</span><input value={timesText} onChange={e => { setTimesText(e.target.value); changeSchedule({ times: timeList(e.target.value) }); }} placeholder="09:00, 21:00" /><small>多个时间用逗号分隔，最多 24 个。</small></label>
                : <label className="lp-field"><span>间隔（分钟）</span><input type="number" min={5} max={720} value={draft.schedule.intervalMinutes} onChange={e => changeSchedule({ intervalMinutes: Number(e.target.value) })} /><small>5–720 分钟，从当天 00:00 起算。</small></label>}
              <label className="lp-field"><span>时区</span><input value={draft.schedule.timezone} onChange={e => changeSchedule({ timezone: e.target.value })} /><small>消息中的时间也按此时区显示。</small></label>
            </div>
            <div className="fd-days" role="group" aria-label="发送日">{WEEKDAYS.map((label, index) => <label key={label}><input type="checkbox" checked={draft.schedule.weekdays.includes(index + 1)} onChange={e => changeSchedule({ weekdays: e.target.checked ? [...draft.schedule.weekdays, index + 1].sort() : draft.schedule.weekdays.filter(day => day !== index + 1) })} />{label}</label>)}</div>
          </fieldset></section>
        <section className="panel lp-section" aria-label="消息内容"><div className="panel-heading"><h2>消息内容</h2></div>
          <fieldset>
            <div className="lp-grid fd-grid"><label className="lp-field"><span>标题</span><input value={draft.title} maxLength={60} onChange={e => change({ title: e.target.value })} /></label></div>
            <div className="fd-options">
              <label className="checkbox-field"><input type="checkbox" checked={draft.onlyOnAttention} onChange={e => change({ onlyOnAttention: e.target.checked })} />仅在有模块需要关注时才发送</label>
              <label className="checkbox-field"><input type="checkbox" checked={draft.showIssues} onChange={e => change({ showIssues: e.target.checked })} />在开头列出问题明细</label>
              <label className="checkbox-field"><input type="checkbox" checked={draft.hideIdle} onChange={e => change({ hideIdle: e.target.checked })} />不显示未启用或未配置的模块</label></div>
            <h3>模块与指标</h3>
            {preview ? <ul className="fd-sections">{preview.catalog.map(item => {
              const setting = draft.sections[item.id] ?? { enabled: true, hidden: [] };
              return <li key={item.id}><div className="fd-section-row"><label className="checkbox-field"><input type="checkbox" checked={setting.enabled} onChange={e => changeSection(item.id, { enabled: e.target.checked })} />{item.name}</label><span className={`fd-level ${item.level}`}>{item.status}</span></div>
                {item.metrics.length && setting.enabled ? <details><summary>选择指标（已选 {item.metrics.filter(metric => !setting.hidden.includes(metric.key)).length}/{item.metrics.length}）</summary><div className="fd-metrics">{item.metrics.map(metric => <label key={metric.key}><input type="checkbox" checked={!setting.hidden.includes(metric.key)} onChange={e => changeSection(item.id, { hidden: e.target.checked ? setting.hidden.filter(key => key !== metric.key) : [...setting.hidden, metric.key] })} />{metric.label}</label>)}</div></details> : null}</li>;
            })}</ul> : <p className="lp-table-empty">{previewError || '正在读取模块'}</p>}
          </fieldset></section>
      </div>
      <div className="fd-column">
        <section className="panel fd-preview" aria-label="消息预览"><div className="panel-heading"><h2>消息预览</h2><span className="muted">{preview ? `${(preview.bytes / 1024).toFixed(1)} KB` : ''}{previewing ? ' · 更新中' : ''}</span></div>
          {previewError ? <div className="lp-callout warning fd-preview-error" role="alert"><CircleAlert size={16} /><span>{previewError}</span></div> : null}
          {preview ? <div className="fd-card"><div className={`fd-card-header ${preview.digest.level}`}>{preview.digest.title} {preview.digest.clock}</div>
            <div className="fd-card-body"><p className="fd-summary">{preview.digest.attention.length ? `${preview.digest.attention.length} 个模块需要关注` : `没有需要处理的问题，共 ${preview.digest.sections.length} 个模块`}</p>
              {draft.showIssues && preview.digest.attention.length ? <ul className="fd-issues">{preview.digest.attention.flatMap(item => (item.issues.length ? item.issues : [item.status]).map(issue => <li key={`${item.name}:${issue}`}><span className={`fd-level ${item.level}`}>{LEVELS[item.level]}</span>{item.name}：{issue}</li>))}</ul> : null}
              {preview.digest.sections.map(section => <PreviewSection key={section.id} section={section} />)}
              {preview.omitted ? <p className="fd-omitted">另有 {preview.omitted} 个模块超出飞书长度限制，不会显示。</p> : null}</div></div> : <p className="lp-table-empty">{previewing ? '正在生成预览' : '暂无预览'}</p>}
        </section>
        <section className="panel lp-section" aria-label="发送记录"><div className="panel-heading"><h2>发送记录</h2><span className="muted">最近 {snapshot.history.length} 次</span></div>
          {snapshot.history.length ? <ol className="lp-events">{snapshot.history.map((entry, index) => <li key={`${entry.at}:${index}`} className={entry.status === 'failed' || entry.status === 'uncertain' ? 'bad' : ''}><time>{when(entry.at)}</time><span>{RESULTS[entry.status]}</span><span>{entry.kind === 'manual' ? '手动' : '定时'}{entry.attention ? ` · ${entry.attention} 个模块需关注` : ''}{entry.error ? ` · ${entry.error}` : ''}</span></li>)}</ol> : <p className="lp-table-empty">尚无发送记录。</p>}
        </section>
      </div>
    </div>}
  </div>;
}

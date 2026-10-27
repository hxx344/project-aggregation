import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, CircleAlert, Download, LoaderCircle, Play, RefreshCw, Save, Square } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from './api';
import type { LabConfig, LabQuote, LabReport, LabSnapshot, LabSpread, LabSymbol, LabTime } from './entropy-lighter-types';
import EntropyLighterInsights from './EntropyLighterInsights';
import EntropyBinanceScalper from './EntropyBinanceScalper';
import './entropy-lighter.css';

const ROOT = '/api/research/entropy-lighter';
const SYMBOLS: LabSymbol[] = ['SNDK', 'ANTH'];
const stateLabels = { starting: '正在启动', running: '采集运行中', stopped: '已停止', fault: '采集异常' };
const numbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
const times = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function timestamp(value: LabTime | null | undefined) { return typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; }
function time(value: LabTime | null | undefined, full = false) { const ms = timestamp(value); return Number.isFinite(ms) ? (full ? dates : times).format(ms) : '尚无记录'; }
function num(value: number | null | undefined, missing = '—') { return typeof value === 'number' && Number.isFinite(value) ? numbers.format(value) : missing; }
function venue(value: string | null | undefined) { return value === 'entropy' ? 'Entropy' : value === 'lighter' ? 'Lighter' : value === 'binance' ? 'Binance' : value || '—'; }
function message(reason: unknown) { return reason instanceof Error ? reason.message : '请求失败，请重试。'; }

type NumericField = { key: string; label: string; min: number; max: number; nullable?: boolean; hint?: string };
const simulationFields: NumericField[] = [
  { key: 'notionalPerLeg', label: '每腿模拟名义金额（USD）', min: 1, max: 100000 },
  { key: 'minEntryEdgeBps', label: '最小开仓价差（bps）', min: 0, max: 1000 },
  { key: 'holdMs', label: '模拟持有时间（ms）', min: 100, max: 60000 },
  { key: 'cooldownMs', label: '模拟冷却时间（ms）', min: 1000, max: 3600000 },
  { key: 'slippageBpsPerFill', label: '每次成交滑点（bps）', min: 0, max: 100 },
  { key: 'fundingReserveBpsPerRoundTrip', label: '每轮资金费预留（bps）', min: 0, max: 100 },
  { key: 'fillWaitMs', label: '等待模拟成交上限（ms）', min: 100, max: 10000 },
];
const collectionFields: NumericField[] = [
  { key: 'maxDataMb', label: '数据容量上限（MB）', min: 16, max: 1048576 },
  { key: 'retentionDays', label: '原始数据保留（天）', min: 1, max: 365 },
  { key: 'maxBookAgeMs', label: '接收报价有效期（ms）', min: 50, max: 10000 },
  { key: 'maxSourceAgeMs', label: '源报价有效期（ms）', min: 100, max: 30000 },
  { key: 'maxPairSkewMs', label: '双腿最大时间差（ms）', min: 0, max: 5000 },
  { key: 'sampleIntervalMs', label: '研究采样间隔（ms）', min: 50, max: 5000 },
];
type Draft = {
  region: string; recordRaw: boolean; simulationEnabled: boolean; verifiedSymbols: LabSymbol[];
  values: Record<string, string>;
  latencyScenarios: { name: string; entropyMs: string; lighterMs: string }[];
};
function draftOf(config: LabConfig): Draft {
  const sim = config.simulation;
  return { region: config.region, recordRaw: config.recordRaw, simulationEnabled: sim.enabled, verifiedSymbols: [...sim.verifiedSymbols],
    values: Object.fromEntries([...collectionFields.map(f => [f.key, config[f.key as keyof LabConfig]]), ...simulationFields.map(f => [f.key, sim[f.key as keyof typeof sim]])].map(([key, value]) => [key, value === null ? '' : String(value)])),
    latencyScenarios: sim.latencyScenarios.map(s => ({ name: s.name, entropyMs: String(s.entropyMs), lighterMs: String(s.lighterMs) })) };
}
function configOf(draft: Draft, current: LabConfig): LabConfig {
  const parse = (raw: string, label: string, min: number, max: number, nullable = false): number | null => {
    if (!raw.trim() && nullable) return null;
    const value = raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}须在 ${min}–${max} 之间。`);
    return value;
  };
  if (draft.region.length > 100) throw new Error('采集地区最多 100 个字符。');
  const config = structuredClone(current);
  config.region = draft.region; config.recordRaw = draft.recordRaw;
  for (const field of collectionFields) Object.assign(config, { [field.key]: parse(draft.values[field.key], field.label, field.min, field.max) });
  config.simulation.enabled = draft.simulationEnabled;
  config.simulation.verifiedSymbols = [...draft.verifiedSymbols];
  for (const field of simulationFields) Object.assign(config.simulation, { [field.key]: parse(draft.values[field.key], field.label, field.min, field.max, field.nullable) });
  if (draft.simulationEnabled && !draft.verifiedSymbols.length) throw new Error('启用模拟需要至少一个已核验标的。');
  config.simulation.entropyTakerFeeBps = null;
  config.simulation.lighterTakerFeeBps = null;
  config.simulation.latencyScenarios = draft.latencyScenarios.map(s => ({ name: s.name,
    entropyMs: parse(s.entropyMs, `${s.name} Entropy 延迟`, 0, 10000)!,
    lighterMs: parse(s.lighterMs, `${s.name} Lighter 延迟`, 300, 10000)! }));
  config.simulation.rebateRatios = [0, 1.1, 1.2];
  return config;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="el-field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}
function Configuration({ draft, setDraft, disabled, dirty, busy, onSave, onReset }: { draft: Draft; setDraft: (draft: Draft) => void; disabled: boolean; dirty: boolean; busy: boolean; onSave: (event: FormEvent) => void; onReset: () => void }) {
  const update = (key: string, value: string) => setDraft({ ...draft, values: { ...draft.values, [key]: value } });
  const fields = (items: NumericField[]) => items.map(f => <Field key={f.key} label={f.label} hint={f.hint}><input type="number" inputMode="decimal" min={f.min} max={f.max} step="any" value={draft.values[f.key]} onChange={e => update(f.key, e.target.value)} /></Field>);
  return <details className="el-config panel"><summary><span>采集与模拟设置</span><span className="el-detail-hint">{disabled ? '停止采集后可编辑' : dirty ? '有未保存的修改' : '展开配置'}</span></summary><form noValidate onSubmit={onSave}>
    <fieldset disabled={disabled || busy}>
      <div className="el-config-intro"><p>使用公开行情；模拟不会向交易所提交订单。关闭或切换页面后，服务器继续采集。</p><label className="el-check"><input type="checkbox" checked={draft.simulationEnabled} onChange={e => setDraft({ ...draft, simulationEnabled: e.target.checked })} />启用成交模拟</label><small>{draft.simulationEnabled ? '仅对已核验标的按自动取得的公开费用和延迟假设模拟；费用未就绪时暂停新增信号，行情继续采集。' : '自动获取公开费用，并同时计算 110% / 120% 返佣情景。'}</small></div>
      <div className="el-verified"><strong>已核验跨所合约身份</strong><div>{SYMBOLS.map(symbol => <label key={symbol} className="el-check"><input type="checkbox" checked={draft.verifiedSymbols.includes(symbol)} onChange={e => setDraft({ ...draft, verifiedSymbols: e.target.checked ? [...draft.verifiedSymbols, symbol] : draft.verifiedSymbols.filter(s => s !== symbol) })} />{symbol}</label>)}</div><p>请先核对底层资产、合约与结算口径。ANTH 同名合约的身份尚未自动核验，勾选表示你已独立核对。</p></div>
      <div className="el-form-grid">{fields(simulationFields.slice(0, 6))}</div>
      <div className="el-latency"><h3>假设订单延迟</h3><p>Lighter Standard taker 至少 300 ms；各情景独立计算，结果不可相加。</p>{draft.latencyScenarios.map((scenario, index) => <div className="el-latency-row" key={scenario.name}><strong>{scenario.name}</strong>{(['entropyMs', 'lighterMs'] as const).map(key => <Field key={key} label={`${venue(key === 'entropyMs' ? 'entropy' : 'lighter')} 延迟（ms）`}><input type="number" min={key === 'lighterMs' ? 300 : 0} max={10000} step="any" value={scenario[key]} onChange={e => setDraft({ ...draft, latencyScenarios: draft.latencyScenarios.map((s, i) => i === index ? { ...s, [key]: e.target.value } : s) })} /></Field>)}</div>)}</div>
      <details className="el-advanced"><summary>高级采集参数</summary><div className="el-form-grid"><Field label="采集地区"><input maxLength={100} value={draft.region} onChange={e => setDraft({ ...draft, region: e.target.value })} /></Field>{fields(collectionFields)}{fields(simulationFields.slice(6))}</div><label className="el-check"><input type="checkbox" checked={draft.recordRaw} onChange={e => setDraft({ ...draft, recordRaw: e.target.checked })} />记录原始行情与诊断</label></details>
    </fieldset><div className="el-form-actions"><span>{disabled ? '采集运行时配置只读。' : dirty ? '保存后再启动，开始新的采集会话。' : '配置已同步。'}</span><div><button type="button" className="button secondary" disabled={!dirty || busy || disabled} onClick={onReset}>恢复已保存配置</button><button className="button primary" disabled={!dirty || busy || disabled} type="submit">{busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存配置</button></div></div>
  </form></details>;
}

function quoteQuality(quote: LabQuote, reportAgeMs: number | null, silenceAfterMs: number | undefined, historical: boolean) {
  if (historical) return { text: '历史记录，观测待更新', tone: 'pending' };
  if (typeof quote.receiveAgeMs !== 'number' || !Number.isFinite(quote.receiveAgeMs) || quote.receiveAgeMs < 0 || reportAgeMs === null || typeof silenceAfterMs !== 'number' || !Number.isFinite(silenceAfterMs)) return { text: '等待新版采样 / 质量未知', tone: 'pending' };
  if (quote.receiveAgeMs + reportAgeMs > silenceAfterMs) return { text: '近期未收到更新', tone: 'stale' };
  return { text: '最近采样有更新', tone: 'good' };
}
function Quotes({ quotes, reportAgeMs, silenceAfterMs, historical }: { quotes: LabQuote[]; reportAgeMs: number | null; silenceAfterMs: number | undefined; historical: boolean }) {
  return <section className="panel el-section el-quotes"><div className="panel-heading"><h2>最新盘口观测</h2><span className="muted">价格单位按原生合约；不跨 USD / USDT 比价格水平</span></div><div className="el-table-scroll"><table className="el-table"><caption className="visually-hidden">最新盘口与逐条时间质量</caption><thead><tr><th>平台 / 标的</th><th>买一</th><th>卖一</th><th>接收时间</th><th>源时间</th><th>观测 / 模拟质量</th></tr></thead><tbody>{quotes.length ? quotes.map(quote => { const quality = quoteQuality(quote, reportAgeMs, silenceAfterMs, historical); return <tr key={`${quote.venue}:${quote.symbol}`}><th scope="row">{venue(quote.venue)} / {quote.symbol}<small>{quote.nativeSymbol}</small></th><td>{num(quote.bid)}</td><td>{num(quote.ask)}</td><td>{time(quote.receivedAt)}<small>{typeof quote.receiveAgeMs === 'number' && reportAgeMs !== null ? `约 ${num((quote.receiveAgeMs + reportAgeMs) / 1000)} 秒前收到` : '接收年龄未知'}</small></td><td>{time(quote.sourceAt)}{quote.sourceClockUncertain ? <small className="el-source-clock">源时钟待核验</small> : null}</td><td><span className={`el-quality ${quality.tone}`}>{quality.text}</span><small>{quote.executionQuality === null ? '采样时满足模拟时效' : typeof quote.executionQuality === 'string' ? `该样本未满足模拟时效（${quote.executionQuality}）` : '模拟质量未知'}</small></td></tr>; }) : <tr><td colSpan={6} className="el-table-empty">尚无盘口。等待数据源连接与身份检查；采集运行不代表行情已可用。</td></tr>}</tbody></table></div></section>;
}

function SpreadChart({ report, config, symbol, onSymbol, historical }: { report: LabReport | null; config: LabConfig; symbol: LabSymbol; onSymbol: (symbol: LabSymbol) => void; historical: boolean }) {
  const points = report?.recentSpreads?.[symbol];
  const data = useMemo(() => {
    const valid = (points || []).map(p => ({ ...p, date: timestamp(p.at) })).filter(p => Number.isFinite(p.date)).sort((a, b) => a.date - b.date).slice(-600);
    const result: (LabSpread & { date: number })[] = [];
    for (const point of valid) {
      const previous = result.at(-1);
      if (previous && point.date - previous.date > Math.max(5000, config.sampleIntervalMs * 4)) result.push({ ...point, date: previous.date + 1, midBasisBps: null, takerEdgeBps: null });
      result.push({ ...point, midBasisBps: Number.isFinite(point.midBasisBps) ? point.midBasisBps : null, takerEdgeBps: Number.isFinite(point.takerEdgeBps) ? point.takerEdgeBps : null });
    }
    return result.map(point => ({ ...point, midBasisPercent: point.midBasisBps === null ? null : point.midBasisBps / 100, takerEdgePercent: point.takerEdgeBps === null ? null : point.takerEdgeBps / 100 }));
  }, [points, config.sampleIntervalMs]);
  const latest = data.at(-1), basis = report?.basis?.[symbol];
  const hasData = data.some(p => p.midBasisBps !== null || p.takerEdgeBps !== null);
  return <section className="panel el-section el-spread"><div className="panel-heading"><h2>两边价格差了多少 <span className="el-unit">%</span></h2><div className="el-symbols" role="group" aria-label="价差标的">{SYMBOLS.map(s => <button key={s} aria-pressed={s === symbol} className={s === symbol ? 'active' : ''} onClick={() => onSymbol(s)}>{s}</button>)}</div></div>
    <div className="el-chart-readings"><div><span className="el-line-key basis">两边中间价之差</span><strong>{num(latest?.midBasisPercent)}<small>%</small></strong><small>正数表示 Entropy 较贵</small></div><div><span className="el-line-key edge">吃单入场价差</span><strong>{num(latest?.takerEdgePercent)}<small>%</small></strong><small>{latest?.buy && latest.sell ? `买 ${venue(latest.buy)} / 卖 ${venue(latest.sell)}` : '尚无可比较盘口'}；未扣费与滑点</small></div><div><span>本轮平均价格差</span><strong>{num(basis?.meanBps === undefined ? null : basis.meanBps / 100)}<small>%</small></strong><small>{num(basis?.samples)} 个采样；整个会话统计</small></div></div>
    <div className="el-chart-meta"><span>{data.length ? `${time(data[0].date, true)} – ${time(data.at(-1)!.date, true)}` : '最近 600 个采样点（默认约 20 分钟）'}（本机时区）</span><span>{historical ? '历史观测' : '接收时间观测'} · 采样展示间隔至少 2 秒</span></div>
    {hasData ? <figure aria-label={`${symbol} 跨所价差时间线，单位百分比；空白表示缺失数据。`}><div className="el-chart"><ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 270 }} minWidth={0}><LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--surface-4)" /><XAxis dataKey="date" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => time(Number(v))} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} minTickGap={48} tickLine={false} axisLine={false} /><YAxis width={58} tickFormatter={v => `${num(Number(v))}%`} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} tickLine={false} axisLine={false} domain={['auto', 'auto']} /><ReferenceLine y={0} stroke="var(--surface-6)" strokeDasharray="3 4" /><Tooltip labelFormatter={v => time(Number(v), true)} formatter={(value, name) => [`${num(Number(value))}%`, name]} contentStyle={{ background: 'var(--surface-3)', border: '1px solid var(--surface-6)', borderRadius: 6, fontSize: 12 }} labelStyle={{ color: 'var(--text-secondary)' }} /><Line name="两边中间价之差" dataKey="midBasisPercent" stroke="var(--accent)" strokeWidth={2} dot={data.length === 1} isAnimationActive={false} connectNulls={false} /><Line name="吃单入场价差（未扣费）" dataKey="takerEdgePercent" stroke="var(--emerald)" strokeWidth={1.5} strokeDasharray="5 3" dot={data.length === 1} isAnimationActive={false} connectNulls={false} /></LineChart></ResponsiveContainer></div><figcaption className="el-chart-note">缺失与断线区间留空。{latest?.sourceClockUncertain ? '最近样本源时钟不确定；' : ''}入场价差未扣手续费、滑点和资金费；价格先变化不等于能抢先成交。</figcaption><details className="el-chart-data"><summary>查看图内数值与 bps</summary><div className="el-table-scroll"><table className="el-table"><thead><tr><th>接收观测时间</th><th>中间价基差（bps）</th><th>taker 价差（bps）</th><th>源时钟</th></tr></thead><tbody>{(points || []).slice(-600).map((p, i) => <tr key={`${p.at}:${i}`}><td>{time(p.at, true)}</td><td>{num(p.midBasisBps)}</td><td>{num(p.takerEdgeBps)}</td><td>{p.sourceClockUncertain ? '待核验' : '已提供源时间'}</td></tr>)}</tbody></table></div></details></figure> : <div className="el-empty"><Activity size={24} /><strong>尚无 {symbol} 可比较价差</strong><p>需要两侧新鲜盘口及相近的接收时间。缺失数据不会按零补齐。</p></div>}
  </section>;
}

function PaperResults({ report }: { report: LabReport | null }) {
  const sessionConfig = report?.sessionConfig;
  const results = Object.entries(report?.paper || {});
  const hasActivity = results.some(([, r]) => r.completed || r.openTasks || r.unresolved || r.failedLegs);
  return <section className="panel el-section el-paper"><div className="panel-heading"><h2>成交模拟</h2><span className="muted">{report?.mode === 'paper' ? '报告会话启用' : '报告会话未启用'}</span></div>
    <p className="el-section-note">订单延迟为假设值；成交按到达后的公开盘口估算，不代表真实成交与可执行容量。金额为 USD 模拟口径，各延迟情景不可相加。</p>
    {report?.paperSuspendedReason ? <div className="el-callout warning" role="status">模拟已暂停：前次会话存在未解决的模拟敞口，请下载报告核对。</div> : null}
    {!hasActivity ? <div className="el-empty compact"><p>{report?.mode === 'paper' ? '尚无模拟成交。请查看自动费用状态、行情质量、开仓门槛与拒绝原因。' : '只读采集模式。费用自动获取；停止采集后可核验标的并启用模拟。'}</p></div> : <>
      <div className="el-table-scroll"><table className="el-table"><caption className="visually-hidden">各延迟情景独立的模拟结果</caption><thead><tr><th>延迟情景</th><th>完成 / 未结</th><th>失败腿</th><th>成交额 E / L（USD）</th><th>毛收益（USD）</th><th>手续费（USD）</th><th>预留成本（USD）</th><th>返佣前净收益（USD）</th></tr></thead><tbody>{results.map(([name, result]) => <tr key={name}><th scope="row">{name}{sessionConfig?.simulation.latencyScenarios.find(s => s.name === name) ? <small>E {num(sessionConfig.simulation.latencyScenarios.find(s => s.name === name)!.entropyMs)} / L {num(sessionConfig.simulation.latencyScenarios.find(s => s.name === name)!.lighterMs)} ms</small> : null}</th><td>{num(result.completed)} / {num(result.openTasks + result.unresolved)}</td><td>{num(result.failedLegs)}</td><td>{num(result.turnover?.entropy)} / {num(result.turnover?.lighter)}</td><td>{num(result.grossPnl, '待结算')}</td><td>{num(result.fees, '未知')}</td><td>{num(result.costReserve)}</td><td>{num(result.netBeforeRebate, '待结算')}</td></tr>)}</tbody></table></div>
      <div className="el-table-scroll"><table className="el-table"><caption>假设返佣敏感性：按已知 Entropy 手续费计算，未到账</caption><thead><tr><th>延迟情景</th><th>返佣比例</th><th>假设返佣（USD）</th><th>返佣后净收益（USD）</th></tr></thead><tbody>{results.flatMap(([name, result]) => (result.rebateScenarios || []).map((rebate, i) => <tr key={`${name}:${i}`}><th scope="row">{name}</th><td>{num(rebate.ratio * 100)}%</td><td>{num(rebate.contingentRebate)}</td><td>{num(rebate.net, '待结算')}</td></tr>))}</tbody></table></div></>}
    <div className="el-assumptions">{report?.automaticFees ? '当前公开费率见各标的研究卡；每笔模拟按信号创建时锁定的费用版本结算，版本与来源可在下载报告的 feeSnapshot 核对。' : report ? '该历史报告未记录自动费用版本，历史费用来源未知；保留原始结果。' : '尚无采集报告。'}更改配置或更新费用不重算历史记录；资金费采用预留值，110% / 120% 按 Entropy 整轮总手续费分别计算，返佣未到账。</div>
  </section>;
}

function Diagnostics({ report }: { report: LabReport | null }) {
  const markouts = Object.entries(report?.leaderMarkouts || {});
  const rtts = Object.entries(report?.diagnostics?.rttMs || {}).map(([key, values]) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return { key, samples: sorted.length, p50: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .5))] : null, p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] : null }; });
  return <div className="el-diagnostics"><section className="panel el-section"><div className="panel-heading"><h2>领先观测 markout</h2></div><p className="el-section-note">以 Binance 本地接收变化为触发，观察跟随平台在各窗口的方向收益；不是因果或可成交领先证明。</p><div className="el-table-scroll"><table className="el-table"><thead><tr><th>标的 / 跟随平台</th><th>窗口（ms）</th><th>样本数</th><th>方向命中率</th><th>有向变动（bps）</th></tr></thead><tbody>{markouts.length ? markouts.map(([key, row]) => { const [symbol, source, lag] = key.split(':'); return <tr key={key}><th scope="row">{symbol} / {venue(source)}</th><td>{lag}</td><td>{num(row.samples)}</td><td>{num(row.directionHitRate * 100)}%</td><td>{num(row.meanSignedMoveBps)}</td></tr>; }) : <tr><td colSpan={5} className="el-table-empty">尚无完整的领先观测样本。</td></tr>}</tbody></table></div></section>
    <section className="panel el-section"><div className="panel-heading"><h2>数据源往返时间</h2><span className="el-unit">ms</span></div><p className="el-section-note">HTTP / WS RTT 是采集链路往返时间，不是订单延迟。每项最多使用最近 1000 次记录。</p><div className="el-table-scroll"><table className="el-table"><thead><tr><th>来源 / 测量</th><th>样本数</th><th>p50（ms）</th><th>p95（ms）</th></tr></thead><tbody>{rtts.length ? rtts.map(r => <tr key={r.key}><th scope="row">{r.key.split(':').map((s, i) => i === 0 ? venue(s) : s).join(' / ')}</th><td>{num(r.samples)}</td><td>{num(r.p50)}</td><td>{num(r.p95)}</td></tr>) : <tr><td colSpan={4} className="el-table-empty">尚无链路测量，不能据此估算订单延迟。</td></tr>}</tbody></table></div><div className="el-assumptions">事件循环延迟 p50 / p95 / p99：{num(report?.eventLoopDelayMs?.p50)} / {num(report?.eventLoopDelayMs?.p95)} / {num(report?.eventLoopDelayMs?.p99)} ms</div></section>
    <details className="panel el-diagnostic-details"><summary>采样拒绝与连接诊断</summary><div className="el-table-scroll"><table className="el-table"><thead><tr><th>原因 / 事件</th><th>次数</th><th>最近记录</th></tr></thead><tbody>{Object.entries(report?.counts?.rejected || {}).map(([key, count]) => <tr key={`reject:${key}`}><th scope="row">{key}</th><td>{num(count)}</td><td>—</td></tr>)}{Object.entries(report?.diagnostics?.counts || {}).map(([key, count]) => { const last = report?.diagnostics?.last?.[key]; return <tr key={key}><th scope="row">{key}</th><td>{num(count)}</td><td>{time(last?.at)}{last?.reason || last?.message || last?.details?.reason ? <small>{last.reason || last.message || last.details?.reason}</small> : null}</td></tr>; })}{!Object.keys(report?.counts?.rejected || {}).length && !Object.keys(report?.diagnostics?.counts || {}).length ? <tr><td colSpan={3} className="el-table-empty">暂无诊断记录。</td></tr> : null}</tbody></table></div></details>
  </div>;
}

export default function EntropyLighterPage({ onExpired }: { onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [symbol, setSymbol] = useState<LabSymbol>('SNDK');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const busyRef = useRef('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const [lastRead, setLastRead] = useState<number | null>(null);
  const receivedClock = useRef<{ mono: number; serverNow: number | null; reportAgeMs: number | null } | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const lifetime = useRef<AbortController | null>(null);
  const request = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const generation = useRef(0);
  const accept = useCallback((data: LabSnapshot, replaceDraft = false, transportAgeMs = 0) => {
    const mono = performance.now();
    const age = Math.max(0, transportAgeMs);
    receivedClock.current = { mono, serverNow: typeof data.serverNow === 'number' && Number.isFinite(data.serverNow) ? data.serverNow + age : null, reportAgeMs: typeof data.reportAgeMs === 'number' && Number.isFinite(data.reportAgeMs) && data.reportAgeMs >= 0 ? data.reportAgeMs + age : null };
    setSnapshot(data); setLastRead(receivedClock.current.serverNow); setNow(mono); setLoadError(''); setUncertain(false);
    if (!dirtyRef.current || replaceDraft) { setDraft(draftOf(data.config)); dirtyRef.current = false; setDirty(false); }
  }, []);
  const read = useCallback((force = false) => {
    if (!lifetime.current || lifetime.current.signal.aborted || document.hidden || !navigator.onLine) return Promise.resolve();
    if (request.current && !force) return request.current.promise;
    request.current?.controller.abort();
    const controller = new AbortController(), version = ++generation.current;
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
    const requestStarted = performance.now();
    setLoading(true);
    const promise = (async () => {
      try { const data = await api<LabSnapshot>(ROOT, { signal, timeoutMs: 10_000 }); if (!signal.aborted && version === generation.current) accept(data, false, performance.now() - requestStarted); }
      catch (reason) { if (signal.aborted || version !== generation.current) return; if (reason instanceof ApiError && reason.status === 401) onExpired(); else setLoadError(message(reason)); }
      finally { if (version === generation.current && !lifetime.current?.signal.aborted) setLoading(false); }
    })().finally(() => { if (request.current?.promise === promise) request.current = null; });
    request.current = { controller, promise }; return promise;
  }, [accept, onExpired]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRead = () => { generation.current++; request.current?.controller.abort(); request.current = null; setLoading(false); };
    const resume = () => {
      setNow(performance.now()); setOffline(!navigator.onLine);
      if (controller.signal.aborted || document.hidden || !navigator.onLine || busyRef.current || resumeTimer !== undefined) return;
      const previous = request.current;
      resumeTimer = setTimeout(() => { resumeTimer = undefined; if (!controller.signal.aborted && !busyRef.current) void read(previous !== null && request.current === previous); }, 250);
    };
    const suspend = () => { clearTimeout(resumeTimer); resumeTimer = undefined; cancelRead(); setOffline(!navigator.onLine); setNow(performance.now()); };
    const visibility = () => { if (document.hidden) suspend(); else resume(); };
    void read();
    const poll = setInterval(() => { if (!busyRef.current && !document.hidden && navigator.onLine && resumeTimer === undefined) void read(); }, 5000);
    const clock = setInterval(() => { if (!document.hidden) setNow(performance.now()); }, 1000);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', resume); window.addEventListener('pageshow', resume); window.addEventListener('online', resume); window.addEventListener('offline', suspend);
    return () => { controller.abort(); generation.current++; request.current?.controller.abort(); request.current = null; clearTimeout(resumeTimer); clearInterval(poll); clearInterval(clock); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', resume); window.removeEventListener('pageshow', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', suspend); };
  }, [read]);
  const changeDraft = (value: Draft) => { setDraft(value); dirtyRef.current = true; setDirty(true); setNotice(''); };
  const execute = async (action: 'start' | 'stop' | 'save' | 'download', config?: LabConfig) => {
    if (busyRef.current || !lifetime.current || lifetime.current.signal.aborted) return;
    busyRef.current = action; setBusy(action); setActionError(''); setNotice('');
    generation.current++; request.current?.controller.abort(); request.current = null; setLoading(false);
    const signal = lifetime.current.signal;
    try {
      if (action === 'download') {
        const result = await api<{ report: LabReport | null }>(`${ROOT}/report`, { signal, timeoutMs: 10_000 });
        if (!result.report) throw new Error('尚无报告；启动采集并取得样本后再下载。');
        const url = URL.createObjectURL(new Blob([JSON.stringify(result.report, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `entropy-lighter-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('报告已下载。');
      } else {
        const requestStarted = performance.now();
        const data = await api<LabSnapshot>(`${ROOT}/${action === 'save' ? 'config' : action}`, { method: action === 'save' ? 'PUT' : 'POST', body: JSON.stringify(action === 'save' ? { config } : {}), signal, timeoutMs: 20_000 });
        if (!signal.aborted) { accept(data, action === 'save', performance.now() - requestStarted); setNotice(action === 'save' ? '配置已保存。' : action === 'start' ? '已请求启动采集。' : '采集已停止，报告已保留。'); }
      }
    } catch (reason) { if (!signal.aborted) { if (reason instanceof ApiError && reason.status === 401) onExpired(); else { setActionError(message(reason)); if (action !== 'download' && !(reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 408)) setUncertain(true); } } }
    finally { busyRef.current = ''; if (!signal.aborted) { setBusy(''); if (action !== 'download') void read(true); } }
  };
  const save = (event: FormEvent) => { event.preventDefault(); if (!draft || !snapshot) return; try { void execute('save', configOf(draft, snapshot.config)); } catch (reason) { setActionError(message(reason)); } };
  const anchor = receivedClock.current;
  const reportAgeMs = anchor?.reportAgeMs !== null && anchor?.reportAgeMs !== undefined ? anchor.reportAgeMs + Math.max(0, now - anchor.mono) : null;
  const serverNow = anchor?.serverNow !== null && anchor?.serverNow !== undefined ? anchor.serverNow + Math.max(0, now - anchor.mono) : null;
  const stale = !!snapshot?.stale || (reportAgeMs !== null && reportAgeMs > 15_000);
  const historical = snapshot?.state === 'stopped' || snapshot?.state === 'fault' || !!snapshot?.report?.stopped || stale || !!loadError || offline;
  const observation = snapshot?.report?.observation;
  const receiving = !historical && reportAgeMs !== null && typeof observation?.silenceAfterMs === 'number' && !!snapshot?.report?.latestQuotes.some(quote => typeof quote.receiveAgeMs === 'number' && Number.isFinite(quote.receiveAgeMs) && quote.receiveAgeMs >= 0 && quote.receiveAgeMs + reportAgeMs <= observation.silenceAfterMs);
  const stopped = snapshot?.state === 'stopped';
  return <div className="el-page">
    <header className="el-heading"><div><h1>Entropy / Lighter</h1><p>先看价差能否覆盖成本，再研究延迟后的机会</p></div><div className="el-toolbar"><button className="button secondary" onClick={() => void execute('download')} disabled={!snapshot?.report || !!busy}><Download size={15} />下载报告</button><button className="button secondary" onClick={() => void read(true)} disabled={!!busy || loading || offline} aria-label="刷新研究数据"><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button>{stopped ? <button className="button primary" disabled={!!busy || loading || uncertain || dirty || !!loadError || offline} title={dirty ? '请先保存配置' : undefined} onClick={() => void execute('start')}>{busy === 'start' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}启动采集</button> : <button className="button secondary" disabled={!snapshot || !!busy || loading || uncertain || offline} onClick={() => void execute('stop')}>{busy === 'stop' ? <LoaderCircle size={15} className="spin" /> : <Square size={15} />}停止采集</button>}</div></header>
    {actionError ? <div className="error-box" role="alert">{actionError}{uncertain ? <p>操作结果尚未确认；刷新状态后再操作。</p> : null}</div> : null}{notice ? <div className="el-callout success" role="status">{notice}</div> : null}
    {offline || loadError ? <div className="el-callout warning" role="alert"><CircleAlert size={16} /><span>{offline ? '浏览器网络已断开。' : `研究数据读取失败：${loadError}`} 当前保留最后读取的数据；连接恢复后自动重试。</span></div> : null}
    {!snapshot ? <section className="panel el-empty" role="status">{loading ? <LoaderCircle className="spin" /> : <CircleAlert />}<strong>{loading ? '正在读取采集状态' : '暂未取得研究数据'}</strong><p>{loadError ? '请检查工作台服务，或点击刷新重试。' : '无需连接交易账户。'}</p></section> : <>
      <section className="panel el-status-panel" aria-label="研究采集状态"><div className="el-state-main"><span className={`el-state ${snapshot.state} ${historical ? 'pending' : ''}`}><Activity size={16} />{historical && !stopped ? '采集状态待更新' : stateLabels[snapshot.state]}</span><span>{snapshot.report?.mode === 'paper' ? '模拟会话' : '纯采集'}</span><span className={`el-quality ${receiving ? 'good' : 'pending'}`}>{historical ? '观测待更新 / 历史记录' : receiving ? '持续收到行情' : reportAgeMs === null ? '等待新版采样' : '等待行情更新'}</span>{snapshot.error ? <p className="el-server-error">{snapshot.error}</p> : null}</div><dl className="el-status-facts"><div><dt>采集心跳</dt><dd>{time(snapshot.heartbeatAt, true)}</dd></div><div><dt>报告距今</dt><dd>{reportAgeMs === null ? '年龄未知' : `${num(reportAgeMs / 1000)} 秒`}<small>{historical ? '保留的观测' : '前台每 5 秒读取'}</small></dd></div><div><dt>本轮收到盘口</dt><dd>{num(snapshot.report?.counts?.books)} 条<small>页面最近读取 {time(lastRead)}</small></dd></div><div><dt>会话开始</dt><dd>{time(snapshot.report?.startedAt, true)}</dd></div></dl><p className="el-status-note">行情是否持续到达与模拟准入分别判断。关闭页面后服务器继续采集；本页不提交交易订单。</p></section>
      <EntropyBinanceScalper report={snapshot.report} symbol={symbol} onSymbol={setSymbol} historical={historical} stopped={stopped} reportAgeMs={reportAgeMs} serverNow={serverNow} />
      <EntropyLighterInsights insights={reportAgeMs !== null && observation && serverNow !== null ? snapshot.insights : undefined} historical={historical} stopped={stopped} report={snapshot.report} reportAgeMs={reportAgeMs} serverNow={serverNow} />
      <SpreadChart report={snapshot.report} config={snapshot.report?.sessionConfig || snapshot.config} symbol={symbol} onSymbol={setSymbol} historical={historical} />
      <details className="el-technical"><summary>技术与模拟明细<span>盘口、成交模拟、连接诊断与参数设置</span></summary><div className="el-technical-content">
        <Quotes quotes={snapshot.report?.latestQuotes || []} reportAgeMs={reportAgeMs} silenceAfterMs={observation?.silenceAfterMs} historical={historical} />
        <PaperResults report={snapshot.report} />
        {draft ? <Configuration draft={draft} setDraft={changeDraft} disabled={!stopped || uncertain} dirty={dirty} busy={busy === 'save'} onSave={save} onReset={() => { setDraft(draftOf(snapshot.config)); dirtyRef.current = false; setDirty(false); setActionError(''); }} /> : null}
        <Diagnostics report={snapshot.report} />
      </div></details>
    </>}
  </div>;
}

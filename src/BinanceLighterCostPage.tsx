import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Archive, CircleAlert, Download, LoaderCircle, Play, RefreshCw, Save, Square } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from './api';
import type { CostBook, CostConfig, CostQuote, CostReport, CostScenario, CostScenarioDetail, CostSnapshot, CostSymbol } from './binance-lighter-cost-types';
import './binance-lighter-cost.css';

const ROOT = '/api/research/binance-lighter-cost';
const SOURCE_CLOCK_TOLERANCE_MS = 250;
const numbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 });
const durationNumbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const tinyNumbers = new Intl.NumberFormat('zh-CN', { notation: 'scientific', maximumFractionDigits: 4 });
const times = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const stateLabels = { stopped: '已停止', starting: '正在启动', running: '模拟运行中', fault: '模拟异常' };
const phaseLabels: Record<string, string> = { waiting: '等待合格行情', quoting: '双边报价中', hedging: '净敞口对冲中', recovering: '等待恢复', blocked: '已阻止报价', stopped: '已停止' };
const reasonLabels: Record<string, string> = {
  waiting_market_data: '等待公开行情', market_metadata_unavailable: '合约资料尚未就绪', market_rules_changed: '合约规则已变化', book_unavailable: '盘口暂不满足模拟条件', book_pair_skew: '双腿行情时间差超限',
  invalid_book: '盘口校验未通过', book_time_regression: '盘口时间回退', feed_unavailable: '行情源暂不可用', below_market_minimum: '数量或名义额低于合约下限',
  hedge_timeout: '等待对冲盘口超时', hedge_ioc_partial_or_slippage: '对冲深度不足或滑点超限', hedge_retries_exhausted: '对冲重试已耗尽',
  unhedgeable_remainder: '剩余数量无法满足对冲下限', inventory_limit: '库存达到限制', unhedged_limit: '净敞口达到限制', valuation_unavailable: '缺少合格估值价格',
  below_hedge_threshold: '低于对冲阈值，继续报价',
  stopped: '会话已停止', sequence_gap: '盘口序列缺失', disconnected: '公开行情连接中断',
};
function reasonText(reason: string) { return reasonLabels[reason] || reason; }
function num(value: number | null | undefined) { return typeof value === 'number' && Number.isFinite(value) ? (value !== 0 && Math.abs(value) < 1e-8 ? tinyNumbers : numbers).format(value) : '—'; }
function time(value: number | null | undefined, full = false) { return typeof value === 'number' && Number.isFinite(value) ? (full ? dates : times).format(value) : '未知'; }
function venue(value: string) { return value === 'binance' ? 'Binance' : 'Lighter'; }
function scenarioName(scenario: CostScenario) { return `${scenario.symbol} · ${scenario.latencyMs} ms`; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '请求未完成，请刷新核对。'; }
function CostValue({ value }: { value: number | null | undefined }) {
  return <span className={typeof value === 'number' && value < 0 ? 'blc-benefit' : ''}>{num(value)}{typeof value === 'number' && value < 0 ? <small>模拟盯市收益</small> : null}</span>;
}

type NumberKey = Exclude<keyof CostConfig, 'schema' | 'symbols' | 'latencyScenarios'>;
type NumericField = { key: NumberKey; label: string; min: number; max: number; integer?: boolean; hint?: string; nullable?: boolean };
const fields: NumericField[] = [
  { key: 'orderNotional', label: '单侧基础报价名义额（USDC）', min: 10, max: 100000 },
  { key: 'maxInventoryNotional', label: 'BN 库存名义额上限（USDC）', min: 10, max: 1000000 },
  { key: 'maxUnhedgedNotional', label: '净敞口名义额上限（USDC）', min: 10, max: 1000000 },
  { key: 'hedgeThresholdNotional', label: '对冲阈值（USDC）', min: 0, max: 1000000, hint: '默认 1,000。低于阈值继续报价；达到或超过时对冲完整净敞口。0 表示即时对冲。' },
  { key: 'quoteOffsetBps', label: '基础报价偏移（bps）', min: 0, max: 100 },
  { key: 'inventorySkewBps', label: '库存调价幅度（bps）', min: 0, max: 100 },
  { key: 'quoteRefreshMs', label: '最短重报间隔（ms）', min: 1000, max: 60000, integer: true },
  { key: 'quoteMaxAgeMs', label: '挂单最长寿命（ms）', min: 1000, max: 120000, integer: true },
  { key: 'hedgeWaitMs', label: '对冲等待上限（ms）', min: 100, max: 10000, integer: true },
  { key: 'binanceMakerFeeBps', label: 'Binance Maker 费率（bps）', min: 0, max: 100 },
  { key: 'lighterTakerFeeBps', label: 'Lighter Taker 费率（bps）', min: 0, max: 100 },
  { key: 'fundingCostBpsPerHour', label: '每小时净资金费支出情景（bps）', min: -100, max: 100, nullable: true, hint: '留空为未知；正值为支出，负值为收益。' },
  { key: 'maxBookAgeMs', label: '最大盘口接收年龄（ms）', min: 100, max: 5000, integer: true },
  { key: 'maxSourceAgeMs', label: '最大源数据年龄（ms）', min: 100, max: 10000, integer: true },
  { key: 'maxPairSkewMs', label: '双腿最大时间差（ms）', min: 0, max: 5000, integer: true },
  { key: 'maxHedgeSlippageBps', label: '最大对冲滑点（bps）', min: 0, max: 100 },
  { key: 'queueMultiplier', label: '可见排队量倍数', min: 1, max: 10, hint: '排队代理假设，不能证明真实排队位置。' },
];
type Draft = { values: Record<NumberKey, string>; latencies: string[] };
function draftOf(config: CostConfig): Draft {
  return { values: Object.fromEntries(fields.map(field => [field.key, config[field.key] === null ? '' : String(config[field.key])])) as Record<NumberKey, string>, latencies: config.latencyScenarios.map(String) };
}
function parseNumber(raw: string, label: string, min: number, max: number, integer = false) {
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${label}须为 ${min}–${max} 之间的${integer ? '整数' : '数字'}。`);
  return value;
}
function configOf(draft: Draft, current: CostConfig): CostConfig {
  const result: CostConfig = { ...current, symbols: ['BTC'], latencyScenarios: draft.latencies.map(value => parseNumber(value, 'Lighter 延迟（ms）', 300, 10000, true)) };
  if (new Set(result.latencyScenarios).size !== result.latencyScenarios.length) throw new Error('各个延迟情景不能重复。');
  for (const field of fields) Object.assign(result, { [field.key]: field.nullable && !draft.values[field.key].trim() ? null : parseNumber(draft.values[field.key], field.label, field.min, field.max, field.integer) });
  if (result.maxInventoryNotional < result.orderNotional) throw new Error('BN 库存名义额上限不得小于单侧基础报价名义额。');
  if (result.hedgeThresholdNotional > result.maxUnhedgedNotional) throw new Error('对冲阈值不得大于净敞口名义额上限。');
  if (result.hedgeThresholdNotional > 0 && result.hedgeThresholdNotional < 1e-18) throw new Error('正对冲阈值不能低于 1e-18 USDC。');
  if (result.quoteMaxAgeMs < result.quoteRefreshMs) throw new Error('挂单最长寿命不得小于最短重报间隔。');
  return result;
}

function Configuration({ draft, onChange, disabled, dirty, busy, onSave, onReset }: { draft: Draft; onChange: (value: Draft) => void; disabled: boolean; dirty: boolean; busy: boolean; onSave: (event: FormEvent) => void; onReset: () => void }) {
  const inputs = (list: NumericField[]) => list.map(field => <label className="blc-field" key={field.key}><span>{field.label}</span><input type="number" aria-label={field.label} inputMode="decimal" min={field.min} max={field.max} step={field.integer ? 1 : 'any'} value={draft.values[field.key]} onChange={event => onChange({ ...draft, values: { ...draft.values, [field.key]: event.target.value } })} />{field.hint ? <small>{field.hint}</small> : null}</label>);
  return <details className="panel blc-config"><summary>模拟配置<span>{disabled ? '停止后可编辑' : dirty ? '有未保存的修改' : '已同步'}</span></summary><form noValidate onSubmit={onSave}>
    <fieldset disabled={disabled}><div className="blc-config-intro"><p>新会话仅支持 BTC 永续。费用、延迟与对冲阈值在启动时锁定，修改只用于下一会话。默认零费为公开优惠假设，未核验账户实际费率。</p></div>
      <div className="blc-form-grid">{inputs(fields.slice(0, 12))}</div>
      <div className="blc-latencies"><h3>Lighter 延迟情景</h3><p>Standard 普通 Taker 至少 300 ms；最多 3 个独立情景，默认 300 / 600 / 1000 ms。</p><div>{draft.latencies.map((latency, index) => <label className="blc-field" key={index}><span>情景 {index + 1} 延迟（ms）</span><input type="number" aria-label={'情景 ' + (index + 1) + ' 延迟（ms）'} min={300} max={10000} step={1} value={latency} onChange={event => onChange({ ...draft, latencies: draft.latencies.map((value, i) => i === index ? event.target.value : value) })} /><button type="button" className="button secondary" disabled={draft.latencies.length === 1} onClick={() => onChange({ ...draft, latencies: draft.latencies.filter((_, i) => i !== index) })}>移除情景 {index + 1}</button></label>)}</div><button type="button" className="button secondary" disabled={draft.latencies.length >= 3} onClick={() => onChange({ ...draft, latencies: [...draft.latencies, '1000'] })}>添加延迟情景</button></div>
      <details className="blc-advanced"><summary>盘口时效与排队假设</summary><div className="blc-form-grid">{inputs(fields.slice(12))}</div></details>
    </fieldset><div className="blc-form-actions"><span>{disabled ? '运行或操作待确认时配置只读。' : '保存不会改写已完成的历史结果。'}</span><div><button type="button" className="button secondary" disabled={!dirty || disabled || busy} onClick={onReset}>恢复已保存配置</button><button type="submit" className="button primary" disabled={!dirty || disabled || busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存配置</button></div></div>
  </form></details>;
}

function Quote({ quote, symbol }: { quote: CostQuote | null; symbol: CostSymbol }) {
  return quote ? <><strong>{num(quote.price)} USDC</strong><small>剩余 {num(quote.remainingQuantity)} / 原量 {num(quote.quantity)} {symbol}<br />前方队列 {num(quote.queueAhead)} {symbol}<br />挂单于 {time(quote.submittedAt)}</small></> : <span className="muted">无报价</span>;
}

const InventoryTable = memo(function InventoryTable({ scenarios, selected, onSelect, snapshotLabel }: { scenarios: CostScenario[]; selected: string; onSelect: (id: string) => void; snapshotLabel: string }) {
  return <section className="panel blc-section blc-exposures"><div className="panel-heading"><h2>BN 双边报价与库存</h2><span className="muted">{snapshotLabel}</span></div>
    <p className="blc-note">目标 BN 净库存为 0。多仓降低买价和买量、降低卖价并提高卖量；空仓反向调整。净敞口名义额为 |BN + Lighter 净数量| × 新鲜 Lighter 中间价。Lighter 按会话阈值对冲完整净敞口，每个情景最多一笔在途 IOC；已提交的 IOC 不因敞口低于阈值而取消。</p>
    <div className="blc-table-scroll"><table className="blc-table blc-inventory"><caption>每个标的 × 延迟为独立账户；报价和库存为报告采样记录，非真实委托。</caption><thead><tr><th>标的 / 延迟</th><th>采样状态</th><th>BN 净库存 / 均价</th><th>BN 买单</th><th>BN 卖单</th><th>Lighter 净库存 / 均价</th><th>净敞口 / 对冲后预计</th><th>Lighter 在途对冲</th></tr></thead><tbody>{scenarios.length ? scenarios.map(scenario => <tr key={scenario.id} data-scenario-id={scenario.id} className={selected === scenario.id ? 'selected' : ''}>
      <th scope="row"><button type="button" className="blc-scenario-select" aria-pressed={selected === scenario.id} onClick={() => onSelect(scenario.id)}>{scenario.symbol}<small>{scenario.latencyMs} ms</small></button></th>
      <td>{phaseLabels[scenario.status]}{scenario.reason ? <small>{reasonText(scenario.reason)}</small> : null}</td>
      <td className="blc-binance-inventory"><strong>{num(scenario.inventory.binanceQuantity)} {scenario.symbol}</strong><small>{scenario.inventory.binanceQuantity > 0 ? '多仓' : scenario.inventory.binanceQuantity < 0 ? '空仓' : '零库存'} · 均价 {num(scenario.inventory.binanceAveragePrice)} USDC<br />名义额 {num(scenario.inventory.binanceNotional)} / 上限 {num(scenario.inventory.limitNotional)} USDC<br />有向库存占比 {scenario.inventory.utilization === null ? '—' : num(scenario.inventory.utilization * 100) + '%'}</small></td>
      <td className="blc-buy-quote"><Quote quote={scenario.quotes.buy} symbol={scenario.symbol} /></td><td className="blc-sell-quote"><Quote quote={scenario.quotes.sell} symbol={scenario.symbol} /></td>
      <td>{num(scenario.inventory.lighterQuantity)} {scenario.symbol}<small>均价 {num(scenario.inventory.lighterAveragePrice)} USD 参考价</small></td>
      <td className="blc-residual-inventory">{num(scenario.inventory.residualQuantity)} {scenario.symbol}<small>净敞口名义额：{typeof scenario.inventory.residualNotional === 'number' && Number.isFinite(scenario.inventory.residualNotional) ? `${num(scenario.inventory.residualNotional)} USDC` : '未知'}<br />在途对冲全部成交后：<br />{num(scenario.inventory.projectedResidualQuantity)} {scenario.symbol}</small></td>
      <td>{scenario.hedge ? <>{scenario.hedge.side === 'buy' ? '买入' : '卖出'} {num(scenario.hedge.quantity)} {scenario.symbol}<small>最早执行 {time(scenario.hedge.dueAt)}<br />第 {scenario.hedge.attempt} 次尝试</small></> : '无在途对冲'}</td>
    </tr>) : <tr><td colSpan={8} className="blc-empty">尚无库存策略会话。启动后按标的与延迟独立模拟双边报价。</td></tr>}</tbody></table></div>
  </section>;
});

const ScenarioTable = memo(function ScenarioTable({ scenarios, selected, snapshotLabel }: { scenarios: CostScenario[]; selected: string; snapshotLabel: string }) {
  return <section className="panel blc-section"><div className="panel-heading"><h2>独立情景 · 盯市成本比较</h2><span className="muted">{snapshotLabel}</span></div><p className="blc-note">各行不可相加为账户总收益。盯市成本包含未平库存估值，正值为支出、负值为模拟盯市收益，不代表可兑现利润；资金费单列为假设情景。</p><div className="blc-table-scroll"><table className="blc-table blc-scenarios"><caption>（全部费用 − 两场所已实现价格盈亏 − 未实现盈亏）÷ 全部 BN 模拟成交额 × 10,000。Lighter 成交额不计入分母。</caption><thead><tr><th>标的 / 延迟</th><th>每万 BN 盯市成本<small>USDC / 每万 BN</small></th><th>两场所已实现 / 未实现盈亏<small>USDC</small></th><th>全部费用 / 净盈亏<small>USDC</small></th><th>盯市成本<small>USDC · 未平库存参与估值</small></th><th>BN / Lighter 成交额<small>USDC · 全会话</small></th><th>Maker / 对冲成交笔数</th><th>资金费情景支出<small>USDC · 非实际结算</small></th><th>含资金费情景成本<small>USDC / 每万 BN</small></th></tr></thead><tbody>{scenarios.length ? scenarios.map(scenario => <tr key={scenario.id} className={selected === scenario.id ? 'selected' : ''}>
      <th scope="row">{scenario.symbol}<small>{scenario.latencyMs} ms</small></th><td className="blc-marked-cost"><CostValue value={scenario.valuation.valid ? scenario.stats.costPer10000 : null} /><small className="blc-valuation">{scenario.valuation.valid ? `采样估值 ${time(scenario.valuation.at)}` : `估值未知${scenario.valuation.reason ? ' · ' + reasonText(scenario.valuation.reason) : ''}`}</small></td>
      <td>{num(scenario.stats.realizedPnl)} / {num(scenario.valuation.valid ? scenario.stats.unrealizedPnl : null)}</td><td>{num(scenario.stats.fees)} / {num(scenario.valuation.valid ? scenario.stats.netPnl : null)}</td><td>{num(scenario.valuation.valid ? scenario.stats.markedCost : null)}</td><td>{num(scenario.stats.binanceTurnover)} / {num(scenario.stats.lighterTurnover)}</td><td>{num(scenario.stats.makerFills)} / {num(scenario.stats.hedgeFills)}<small>重报 {num(scenario.stats.quoteUpdates)} · 对冲失败 {num(scenario.stats.hedgeFailures)}</small></td><td>{num(scenario.stats.fundingScenarioCost)}</td><td><CostValue value={scenario.valuation.valid ? scenario.stats.modeledCostPer10000 : null} /></td>
    </tr>) : <tr><td colSpan={9} className="blc-empty">尚无模拟会话</td></tr>}</tbody></table></div></section>;
});

const ScenarioDetails = memo(function ScenarioDetails({ scenario, detail, loading, error, stale }: { scenario: CostScenario | null; detail: CostScenarioDetail | null; loading: boolean; error: string; stale: boolean }) {
  const history = useMemo(() => detail?.scenario.history.slice(-300) || [], [detail]);
  const fills = useMemo(() => detail?.scenario.recentFills.slice(-200).reverse() || [], [detail]);
  const events = useMemo(() => detail?.scenario.events.slice(-30).reverse() || [], [detail]);
  if (!scenario) return null;
  return <section className="panel blc-section blc-selected-detail" data-scenario-id={scenario.id} data-session-id={detail?.sessionId || ''}><div className="panel-heading"><h2>所选情景 · 盯市成本与逐笔记录</h2><span className="muted">{scenarioName(scenario)}</span></div><div className="blc-chart-facts"><div><span>采样盯市成本 / 每万 BN 模拟成交额</span><strong><CostValue value={scenario.valuation.valid ? scenario.stats.costPer10000 : null} /><small> USDC</small></strong></div><div><span>含资金费情景成本 / 每万 BN</span><strong><CostValue value={scenario.valuation.valid ? scenario.stats.modeledCostPer10000 : null} /><small> USDC</small></strong></div></div>
    <p className="blc-note blc-detail-status" role="status">{detail ? `详情生成于 ${time(detail.updatedAt, true)}` : '尚未取得该情景详情'}{loading ? ' · 正在读取详情' : stale && detail ? ' · 保留历史详情，等待更新' : ''}{error ? ` · 详情读取失败：${error}` : ''}</p>
    <div className="blc-chart-key"><span>— 盯市成本（含未平库存）</span><span>┄ 含资金费情景</span><span>按实际时间 · 最近 {history.length} / 最多 300 点</span></div>
    {history.some(point => point.costPer10000 !== null || point.modeledCostPer10000 !== null) ? <div className="blc-chart" role="img" aria-label={`${scenarioName(scenario)} 盯市成本走势，正数为支出，负数为模拟盯市收益，缺失记录不连线。`}><ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 260 }}><LineChart data={history} margin={{ top: 10, right: 20, left: 4, bottom: 4 }}><CartesianGrid stroke="var(--surface-4)" strokeDasharray="3 3" /><XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} tickFormatter={value => time(value)} minTickGap={35} tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} /><YAxis width={62} tickFormatter={value => num(value)} tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} /><Tooltip labelFormatter={value => time(Number(value), true)} formatter={(value, name) => [`${num(typeof value === 'number' ? value : null)} USDC / 每万 BN`, name]} contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--surface-5)', borderRadius: 6, fontSize: 12 }} /><ReferenceLine y={0} stroke="var(--text-tertiary)" /><Line name="盯市成本（含未平库存）" dataKey="costPer10000" type="linear" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} /><Line name="含资金费情景" dataKey="modeledCostPer10000" type="linear" stroke="var(--text-secondary)" strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div> : <div className="blc-empty">{detail ? '尚无可用盯市成本；成交额为空或估值缺失时不显示为零。' : loading ? '正在读取所选情景的成本走势…' : '成本走势尚未取得，请刷新状态重试。'}</div>}
    <p className="blc-note">已实现盈亏按各场所平均成本账本计算；未实现盈亏按合格双腿中间价估值。滑点和延迟已体现在成交价内。累计统计覆盖全会话，导出的逐笔、曲线与事件保留滚动窗口；实际资金费未知。</p>
    <details className="blc-records blc-fills"><summary>最近逐笔模拟成交（{fills.length} / 最多 200 笔）</summary><div className="blc-table-scroll"><table className="blc-table"><thead><tr><th>成交时间 / 源时间</th><th>场所 / 阶段</th><th>方向 / 数量</th><th>成交价格</th><th>名义额 / 费用<small>USDC</small></th></tr></thead><tbody>{fills.length ? fills.map(fill => <tr key={fill.id}><td>{time(fill.at)}<small>{time(fill.sourceAt)}</small></td><td>{venue(fill.venue)}<small>{fill.phase === 'quote' ? '双边报价成交' : '净敞口对冲'}</small></td><td>{fill.side === 'buy' ? '买' : '卖'} {num(fill.quantity)} {scenario.symbol}</td><td>{num(fill.price)}<small>{fill.venue === 'binance' ? 'USDC' : 'USD 参考价'}</small></td><td>{num(fill.notional)} / {num(fill.fee)}</td></tr>) : <tr><td colSpan={5} className="blc-empty">尚无模拟成交</td></tr>}</tbody></table></div></details>
    <details className="blc-records blc-events"><summary>最近策略事件（{events.length} / 最多 30 条）</summary><ul className="blc-channels">{events.map((event, index) => <li key={`${event.at}:${index}`}><strong>{time(event.at)} · {phaseLabels[event.type] || reasonText(event.type)}</strong>{event.reason ? <span>{reasonText(event.reason)}</span> : null}</li>)}</ul></details>
  </section>;
});
function Books({ books, report, serverNow, elapsed, historical }: { books: CostBook[]; report: CostReport; serverNow: number | null; elapsed: number; historical: boolean }) {
  const config = report.sessionConfig;
  return <section className="panel blc-section"><div className="panel-heading"><h2>盘口观测与采样校验</h2><span className="muted">报告生成于 {time(report.updatedAt)}</span></div><p className="blc-note">服务器通过 WS 持续接收行情，本页每 5 秒读取一份报告。校验结果属于报告采样时刻；页面快照变旧时显示待更新，当前模拟准入仍由服务器逐次检查。</p><div className="blc-table-scroll"><table className="blc-table"><thead><tr><th>平台 / 标的</th><th>买一 / 卖一</th><th>源更新时间</th><th>接收时间 / 页面快照年龄</th><th>报告采样时校验</th></tr></thead><tbody>{books.length ? books.map(book => {
    const sampledAge = typeof book.ageMs === 'number' && Number.isFinite(book.ageMs) && book.ageMs >= 0 ? book.ageMs : null;
    const sampledSourceAge = typeof book.sourceAt === 'number' && Number.isFinite(book.sourceAt) && Number.isFinite(report.updatedAt) ? report.updatedAt - book.sourceAt : null;
    const age = sampledAge === null ? null : sampledAge + elapsed;
    const sourceAge = typeof book.sourceAt === 'number' && serverNow !== null ? serverNow - book.sourceAt : null;
    // book.valid and the unaged values describe the server's sample. A cached
    // browser frame cannot prove that the independently running WS went stale.
    const sampleFailure = sampledSourceAge !== null && sampledSourceAge < -SOURCE_CLOCK_TOLERANCE_MS ? '采样时源时钟超前超过容差'
      : sampledAge !== null && sampledAge > config.maxBookAgeMs ? '采样时接收年龄超限'
        : sampledSourceAge !== null && sampledSourceAge > config.maxSourceAgeMs ? '采样时源数据年龄超限'
          : book.valid === false ? '采样时未通过校验' : sampledAge === null || sampledSourceAge === null || book.valid !== true ? '采样时效未知' : null;
    const currentKnown = age !== null && age <= config.maxBookAgeMs && sourceAge !== null && sourceAge >= -SOURCE_CLOCK_TOLERANCE_MS && sourceAge <= config.maxSourceAgeMs;
    const label = sampleFailure || (historical ? '历史采样时有效' : currentKnown ? '采样时有效' : '采样时有效 · 当前待更新');
    const tone = sampleFailure ? sampleFailure === '采样时效未知' ? 'historical' : 'stale' : historical || !currentKnown ? 'historical' : 'good';
    const sourceText = sourceAge === null ? '源年龄未知' : sourceAge < 0 ? `源时钟超前 ${durationNumbers.format(-sourceAge)} ms（${sourceAge >= -SOURCE_CLOCK_TOLERANCE_MS ? '容差内' : '超出容差'}）` : `${durationNumbers.format(sourceAge / 1000)} 秒前更新`;
    return <tr key={`${book.venue}:${book.symbol}`}><th scope="row">{venue(book.venue)} / {book.symbol}<small>{book.nativeSymbol}</small></th><td>{num(book.bid)} / {num(book.ask)}<small>{book.venue === 'binance' ? 'USDC' : 'USD 原生参考价'}</small></td><td>{time(book.sourceAt)}<small className="blc-source-age">{sourceText}</small>{sourceAge !== null && sourceAge >= 0 && book.sourceClockUncertain && typeof book.sourceClockDeltaMs === 'number' && book.sourceClockDeltaMs < 0 ? <small>接收时源时钟超前 {durationNumbers.format(-book.sourceClockDeltaMs)} ms</small> : null}</td><td>{time(book.receivedAt)}<small className="blc-book-age">{age === null ? '接收年龄未知' : `${durationNumbers.format(age / 1000)} 秒前收到`}</small></td><td><span className={`blc-quality ${tone}`}>{label}</span><small>采样时接收年龄：{sampledAge === null ? '未知' : `${durationNumbers.format(sampledAge)} ms`}<br />执行门槛：接收 ≤ {config.maxBookAgeMs} ms · 源数据 ≤ {config.maxSourceAgeMs} ms<br />源时钟最多超前 {SOURCE_CLOCK_TOLERANCE_MS} ms，不缩短对冲等待</small></td></tr>;
  }) : <tr><td colSpan={5} className="blc-empty">等待公开盘口</td></tr>}</tbody></table></div></section>;
}

type Action = 'start' | 'stop' | 'save' | 'archive' | 'download';
type Pending = { action: Exclude<Action, 'download'>; config?: CostConfig; sessionId?: string; draftRevision: number };
function confirms(pending: Pending, data: CostSnapshot) {
  if (pending.action === 'start') return data.enabled && (data.state === 'running' || data.state === 'starting');
  if (pending.action === 'stop') return !data.enabled && data.state !== 'running' && data.state !== 'starting';
  if (pending.action === 'archive') return data.report?.sessionId !== pending.sessionId && data.archives.some(archive => archive.sessionId === pending.sessionId);
  const expected = pending.config;
  return !!expected && fields.every(field => data.config[field.key] === expected[field.key]) && data.config.symbols.join(',') === expected.symbols.join(',') && data.config.latencyScenarios.join(',') === expected.latencyScenarios.join(',');
}

export default function BinanceLighterCostPage({ onExpired }: { onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<CostSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false), dirtyRef = useRef(false), draftRevision = useRef(0);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState<Action | ''>(''), busyRef = useRef<Action | ''>('');
  const [uncertain, setUncertain] = useState(false), pending = useRef<Pending | null>(null);
  const [loadError, setLoadError] = useState(''), [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false), [offline, setOffline] = useState(!navigator.onLine);
  const [now, setNow] = useState(() => performance.now());
  const clock = useRef<{ mono: number; serverNow: number; reportElapsed: number } | null>(null);
  const lifetime = useRef<AbortController | null>(null), generation = useRef(0);
  const request = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const [detail, setDetail] = useState<CostScenarioDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false), [detailStale, setDetailStale] = useState(true);
  const [detailError, setDetailError] = useState<{ key: string; message: string } | null>(null);
  const detailTarget = useRef<{ key: string; sessionId: string; scenarioId: string } | null>(null);
  const detailGeneration = useRef(0);
  const detailRequest = useRef<{ key: string; controller: AbortController; promise: Promise<void> } | null>(null);
  const invalidateDetail = useCallback(() => {
    detailGeneration.current++; detailRequest.current?.controller.abort(); detailRequest.current = null;
    if (!lifetime.current?.signal.aborted) { setDetailLoading(false); setDetailStale(true); }
  }, []);
  const accept = useCallback((data: CostSnapshot, transportMs: number, replaceDraft = false) => {
    if (data.schema !== 2 || data.config.schema !== 2 || (data.report && (data.report.schema !== 2 || data.report.strategy !== 'inventory_quotes'))) throw new Error('研究报告版本不匹配，库存策略需要 schema 2。旧版记录请单独下载。');
    const mono = performance.now(), transport = Math.max(0, transportMs);
    clock.current = { mono, serverNow: data.serverNow + transport, reportElapsed: (data.report ? Math.max(0, data.serverNow - data.report.updatedAt) : 0) + transport };
    if (detailTarget.current && detailTarget.current.sessionId !== data.report?.sessionId) { invalidateDetail(); setDetail(null); }
    setSnapshot(data); setNow(mono); setLoadError('');
    if (pending.current && confirms(pending.current, data)) { replaceDraft ||= pending.current.action === 'save' && pending.current.draftRevision === draftRevision.current; pending.current = null; setUncertain(false); setActionError(''); setNotice('已读取并核对操作结果。'); }
    if (!dirtyRef.current || replaceDraft) { setDraft(draftOf(data.config)); dirtyRef.current = false; setDirty(false); }
  }, [invalidateDetail]);
  const read = useCallback((force = false) => {
    if (!lifetime.current || lifetime.current.signal.aborted || document.hidden || !navigator.onLine || busyRef.current) return Promise.resolve();
    if (request.current && !force) return request.current.promise;
    request.current?.controller.abort();
    const controller = new AbortController(), version = ++generation.current, started = performance.now();
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
    setLoading(true);
    const promise = (async () => {
      try { const data = await api<CostSnapshot>(ROOT, { signal, timeoutMs: 10_000 }); if (!signal.aborted && version === generation.current) accept(data, performance.now() - started); }
      catch (error) { if (signal.aborted || version !== generation.current) return; if (error instanceof ApiError && error.status === 401) onExpired(); else setLoadError(errorMessage(error)); }
      finally { if (version === generation.current && !lifetime.current?.signal.aborted) setLoading(false); }
    })().finally(() => { if (request.current?.promise === promise) request.current = null; });
    request.current = { controller, promise }; return promise;
  }, [accept, onExpired]);
  const readDetail = useCallback((sessionId: string, scenarioId: string) => {
    if (!lifetime.current || lifetime.current.signal.aborted || document.hidden || !navigator.onLine || busyRef.current) return Promise.resolve();
    const key = `${sessionId}/${scenarioId}`;
    if (detailRequest.current?.key === key) return detailRequest.current.promise;
    detailRequest.current?.controller.abort();
    const controller = new AbortController(), version = ++detailGeneration.current;
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
    setDetailLoading(true); setDetailStale(true); setDetailError(null);
    const promise = (async () => {
      try {
        const data = await api<CostScenarioDetail>(`${ROOT}/scenario/${encodeURIComponent(sessionId)}/${encodeURIComponent(scenarioId)}`, { signal, timeoutMs: 10_000 });
        if (signal.aborted || version !== detailGeneration.current || detailTarget.current?.key !== key) return;
        if (data.sessionId !== sessionId || data.scenario?.id !== scenarioId) throw new Error('会话或情景已变化，请刷新状态。');
        setDetail({ ...data, scenario: { ...data.scenario, recentFills: data.scenario.recentFills.slice(-200), history: data.scenario.history.slice(-300), events: data.scenario.events.slice(-30) } });
        setDetailStale(false);
      } catch (error) {
        if (signal.aborted || version !== detailGeneration.current || detailTarget.current?.key !== key) return;
        if (error instanceof ApiError && error.status === 401) onExpired();
        else {
          const moved = error instanceof ApiError && (error.status === 409 || error.status === 404);
          if (moved) setDetail(null);
          setDetailError({ key, message: moved ? '会话或情景已变化，等待状态更新。' : errorMessage(error) });
        }
      } finally { if (!signal.aborted && version === detailGeneration.current) setDetailLoading(false); }
    })().finally(() => { if (detailRequest.current?.promise === promise) detailRequest.current = null; });
    detailRequest.current = { key, controller, promise }; return promise;
  }, [onExpired]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const suspend = () => { clearTimeout(resumeTimer); resumeTimer = undefined; generation.current++; request.current?.controller.abort(); request.current = null; invalidateDetail(); setLoading(false); setOffline(!navigator.onLine); setNow(performance.now()); };
    const resume = () => {
      setOffline(!navigator.onLine); setNow(performance.now());
      if (controller.signal.aborted || document.hidden || !navigator.onLine || busyRef.current || resumeTimer !== undefined) return;
      const previous = request.current;
      resumeTimer = setTimeout(() => { resumeTimer = undefined; if (!controller.signal.aborted && !busyRef.current) void read(previous !== null && previous === request.current); }, 250);
    };
    const visibility = () => { if (document.hidden) suspend(); else resume(); };
    void read();
    const poll = setInterval(() => { if (resumeTimer === undefined) void read(); }, 5000);
    const tick = setInterval(() => { if (!document.hidden) setNow(performance.now()); }, 1000);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('online', resume); window.addEventListener('offline', suspend); window.addEventListener('focus', resume); window.addEventListener('pageshow', resume);
    return () => { controller.abort(); generation.current++; request.current?.controller.abort(); request.current = null; detailGeneration.current++; detailRequest.current?.controller.abort(); detailRequest.current = null; clearTimeout(resumeTimer); clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', resume); window.removeEventListener('offline', suspend); window.removeEventListener('focus', resume); window.removeEventListener('pageshow', resume); };
  }, [read, invalidateDetail]);
  const changeDraft = (value: Draft) => { draftRevision.current++; dirtyRef.current = true; setDirty(true); setDraft(value); setNotice(''); };
  const execute = async (action: Action, config?: CostConfig, archiveSessionId?: string) => {
    if (busyRef.current || (pending.current && action !== 'download') || !lifetime.current || lifetime.current.signal.aborted) return;
    busyRef.current = action; setBusy(action); setActionError(''); setNotice('');
    generation.current++; request.current?.controller.abort(); request.current = null; setLoading(false);
    if (action !== 'download') invalidateDetail();
    const signal = lifetime.current.signal, revision = draftRevision.current;
    const operation: Pending | null = action === 'download' ? null : { action, config, sessionId: snapshot?.report?.sessionId, draftRevision: revision };
    try {
      if (action === 'download') {
        const data = await api<unknown>(`${ROOT}/report${archiveSessionId ? `/${encodeURIComponent(archiveSessionId)}` : ''}`, { signal, timeoutMs: 10_000 });
        if (signal.aborted) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `binance-lighter-cost-${archiveSessionId || snapshot?.report?.sessionId || 'archives'}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('报告已导出。');
      } else {
        const started = performance.now();
        const data = await api<CostSnapshot>(`${ROOT}/${action === 'save' ? 'config' : action}`, { method: action === 'save' ? 'PUT' : 'POST', body: JSON.stringify(action === 'save' ? { config } : {}), signal, timeoutMs: 20_000 });
        if (!signal.aborted) { accept(data, performance.now() - started, action === 'save' && revision === draftRevision.current); setNotice(action === 'save' ? '配置已保存。' : action === 'start' ? '已请求启动模拟。' : action === 'stop' ? '模拟已停止，报价已撤下，库存与历史结果已保留。' : '会话已归档，可启动新的独立会话。'); }
      }
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof ApiError && error.status === 401) onExpired();
        else { setActionError(errorMessage(error)); if (operation && !(error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408)) { pending.current = operation; setUncertain(true); } }
      }
    } finally { busyRef.current = ''; if (!signal.aborted) { setBusy(''); if (action !== 'download') void read(true); } }
  };
  const save = (event: FormEvent) => { event.preventDefault(); if (!draft || !snapshot) return; try { void execute('save', configOf(draft, snapshot.config)); } catch (error) { setActionError(errorMessage(error)); } };
  const report = snapshot?.report || null;
  const scenarios = report?.scenarios || [];
  const selected = scenarios.find(scenario => scenario.id === selectedId) || scenarios[0] || null;
  const sessionId = report?.sessionId || '', scenarioId = selected?.id || '';
  const detailKey = sessionId && scenarioId ? `${sessionId}/${scenarioId}` : '';
  detailTarget.current = detailKey ? { key: detailKey, sessionId, scenarioId } : null;
  useEffect(() => () => invalidateDetail(), [detailKey, invalidateDetail]);
  useEffect(() => { if (sessionId && scenarioId && !busy && !offline) void readDetail(sessionId, scenarioId); }, [snapshot, sessionId, scenarioId, busy, offline, readDetail]);
  const selectedDetail = detail?.sessionId === sessionId && detail.scenario.id === scenarioId ? detail : null;
  const selectScenario = useCallback((id: string) => { if (detailTarget.current?.scenarioId !== id) { invalidateDetail(); setSelectedId(id); } }, [invalidateDetail]);
  const active = !!snapshot?.enabled || snapshot?.state === 'running' || snapshot?.state === 'starting';
  const monotonicAge = clock.current ? Math.max(0, now - clock.current.mono) : 0;
  const reportElapsed = clock.current ? clock.current.reportElapsed + monotonicAge : 0;
  const serverNow = clock.current ? clock.current.serverNow + monotonicAge : null;
  const historical = !active || !!report?.stopped || !!loadError || offline || reportElapsed > 15_000;
  const exposures = scenarios.filter(scenario => scenario.inventory.binanceQuantity !== 0 || scenario.inventory.lighterQuantity !== 0 || scenario.hedge !== null);
  const snapshotLabel = report ? `${historical ? '历史报告' : reportElapsed > report.sessionConfig.maxBookAgeMs ? '报告采样 · 当前待更新' : '报告采样'} ${time(report.updatedAt)}` : '尚无会话';
  const writeDisabled = !!busy || uncertain || offline || !snapshot;
  return <div className="blc-page"><div className="blc-heading"><div><h1>对冲成本研究</h1><p>BN 双边库存报价 × Lighter 净对冲 · BTC 永续</p></div><div className="blc-toolbar"><button className="button secondary" disabled={loading || !!busy || offline} onClick={() => void read(true)}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新状态</button><button className="button secondary" disabled={!!busy || offline || !snapshot || (!report && !snapshot.archives.length)} onClick={() => void execute('download')}><Download size={15} />导出报告</button>{active ? <button className="button secondary" disabled={writeDisabled} onClick={() => void execute('stop')}><Square size={15} />停止模拟</button> : <button className="button primary" disabled={writeDisabled || dirty || exposures.length > 0 || !!report?.interrupted} onClick={() => void execute('start')}><Play size={15} />启动模拟</button>}</div></div>
    <div className="blc-identity"><strong>仅模拟 · 真实订单 0</strong><span>活动资格、有效成交额与奖励待确认；不作为真实成交证明。</span></div>
    {loadError ? <div className="blc-callout warning" role="alert">研究数据读取失败：{loadError} 历史记录仍保留。</div> : null}
    {actionError ? <div className="blc-callout warning" role="alert">{actionError}</div> : null}
    {uncertain ? <div className="blc-callout warning" role="status">操作结果尚未确认，正在读取核对；确认前不会重复提交。</div> : null}
    {notice ? <div className="blc-callout" role="status">{notice}</div> : null}
    <section className="panel blc-status"><div className="blc-status-line"><strong className={`blc-state ${snapshot?.state || 'loading'}`}>{snapshot ? stateLabels[snapshot.state] : '正在读取状态'}</strong><span>{offline ? '浏览器离线，保留历史记录' : active && report && reportElapsed > 15_000 ? '研究报告超过 15 秒未更新' : historical && report ? '当前显示历史观测' : '页面每 5 秒读取聚合报告'}</span>{snapshot?.error ? <span className="blc-warning-text">{snapshot.error}</span> : null}</div><dl><div><dt>当前会话</dt><dd>{report ? time(report.startedAt, true) : '尚无会话'}<small>{report?.sessionId || '启动后建立独立记录'}</small></dd></div><div><dt>计价单位</dt><dd>USDC 名义结算单位<small>不是 USD 法币估值</small></dd></div><div><dt>实际资金费</dt><dd>未知<small>可配置支出情景，未核验实际结算</small></dd></div><div><dt>运行方式</dt><dd>服务器持续模拟<small>关闭页面不会停止模拟</small></dd></div></dl></section>
    {report && !active && (exposures.length > 0 || report.interrupted) ? <div className="blc-callout warning blc-stopped-exposure" role="status"><CircleAlert size={18} /><div><strong>停止后库存保留，开始新会话前须归档</strong><p>{report.interrupted ? '上次会话中断。' : ''} {exposures.length} 个独立情景保留库存或在途对冲。归档仅保存记录，不代表这些库存已平仓。</p></div></div> : null}
    <InventoryTable scenarios={scenarios} selected={selected?.id || ''} onSelect={selectScenario} snapshotLabel={snapshotLabel} />
    <ScenarioTable scenarios={scenarios} selected={selected?.id || ''} snapshotLabel={snapshotLabel} />
    <ScenarioDetails scenario={selected} detail={selectedDetail} loading={detailLoading} error={detailError?.key === detailKey ? detailError.message : ''} stale={detailStale || historical} />
    {report ? <Books books={report.books} report={report} serverNow={serverNow} elapsed={reportElapsed} historical={historical} /> : null}
    {report ? <section className="panel blc-session"><div><h2>会话假设与归档</h2><p>本会话标的：{report.sessionConfig.symbols.join(' / ')}。{report.sessionConfig.symbols.includes('ETH') ? 'ETH 历史记录保留原始标的与假设；新会话仅支持 BTC。' : ''}</p><p className="blc-session-threshold">{report.sessionConfig.hedgeThresholdNotional === undefined ? '本会话对冲规则：旧版即时对冲（原报告未设置阈值）。' : `本会话对冲阈值：${num(report.sessionConfig.hedgeThresholdNotional)} USDC。低于阈值继续报价；达到或超过阈值时对冲完整净敞口。`}</p><p>本会话费用：Binance Maker {num(report.sessionConfig.binanceMakerFeeBps)} bps / Lighter Taker {num(report.sessionConfig.lighterTakerFeeBps)} bps；每小时净资金费支出情景 {report.sessionConfig.fundingCostBpsPerHour === null ? '未设置' : `${num(report.sessionConfig.fundingCostBpsPerHour)} bps`}。</p><p>公开主动成交消耗可见队列仅为 Maker 成交代理；触价、撤单缩量不代表真实成交。Lighter 延迟结束后按新到合格盘口扫单，深度不足保留未对冲量。</p></div><button className="button secondary" disabled={writeDisabled || active} onClick={() => void execute('archive')}><Archive size={15} />归档当前会话</button></section> : null}
    {draft ? <Configuration draft={draft} onChange={changeDraft} disabled={active || uncertain || (busy !== '' && busy !== 'save')} dirty={dirty} busy={!!busy} onSave={save} onReset={() => { if (snapshot) { setDraft(draftOf(snapshot.config)); dirtyRef.current = false; setDirty(false); draftRevision.current++; } }} /> : null}
    {snapshot?.legacySession ? <section className="panel blc-section blc-legacy"><div className="panel-heading"><h2>旧版单轮会话 · 只读保留</h2><button className="button secondary" disabled={!!busy || offline} onClick={() => void execute('download', undefined, snapshot.legacySession!.sessionId)}><Download size={15} />下载旧版报告</button></div><p className="blc-note">{snapshot.legacySession.sessionId} · {time(snapshot.legacySession.startedAt, true)} 开始 · 已完成 {snapshot.legacySession.completed} / 未决 {snapshot.legacySession.unresolved}{snapshot.legacySession.interrupted ? ' · 曾中断' : ''}。这是旧版开平轮次记录，未转换为库存策略结果，以下数量均为历史记录。</p>{snapshot.legacySession.exposures.length ? <div className="blc-table-scroll"><table className="blc-table"><thead><tr><th>旧情景</th><th>BN 数量</th><th>Lighter 数量</th><th>未对冲数量</th></tr></thead><tbody>{snapshot.legacySession.exposures.map(exposure => <tr key={exposure.id}><th scope="row">{exposure.id}</th><td>{num(exposure.binanceQuantity)} {exposure.symbol}</td><td>{num(exposure.lighterQuantity)} {exposure.symbol}</td><td>{num(exposure.residualQuantity)} {exposure.symbol}</td></tr>)}</tbody></table></div> : <p className="blc-note">旧版摘要无保留敞口。</p>}</section> : null}
    {snapshot?.archives.length ? <details className="panel blc-records blc-archives"><summary>历史归档（{snapshot.archives.length}）</summary><p className="blc-note">库存策略与旧版单轮记录分别保留原口径，归档不消除历史敞口。</p><div className="blc-table-scroll"><table className="blc-table"><thead><tr><th>会话 / 模型</th><th>开始 / 结束</th><th>成交摘要</th><th>库存或旧版未决</th><th>中断状态</th><th>原始报告</th></tr></thead><tbody>{snapshot.archives.map(archive => <tr key={`${archive.schema}:${archive.sessionId}`}><th scope="row">{archive.sessionId}<small>{archive.schema === 2 ? '库存策略 · v2' : '旧版单轮 · v1'}</small></th><td>{time(archive.startedAt, true)}<small>{time(archive.endedAt, true)}</small></td><td>{archive.schema === 2 ? `${archive.makerFills} 笔 Maker 成交` : `${archive.completed} 轮已完成`}</td><td>{archive.schema === 2 ? archive.hasExposure ? '库存保留' : '无库存' : `${archive.unresolved} 条旧版未决`}</td><td>{archive.interrupted === true ? '曾中断' : archive.interrupted === false ? '正常结束' : '未记录'}</td><td><button className="button secondary" disabled={!!busy || offline} onClick={() => void execute('download', undefined, archive.sessionId)}>下载归档</button></td></tr>)}</tbody></table></div></details> : null}
    {report?.channels.length ? <details className="panel blc-records"><summary>公开数据源连接</summary><ul className="blc-channels">{report.channels.map((channel, index) => <li key={`${channel.venue}:${channel.channel}:${channel.symbol || index}`}><strong>{venue(channel.venue)} {channel.symbol || ''} · {channel.channel}</strong><span>{historical ? '最近记录 · ' : ''}{({ connected: '已连接', live: '行情接收中', stale: '行情更新滞后', connecting: '连接中', disconnected: '已断开', fault: '连接异常' } as Record<string, string>)[channel.state] || channel.state}{channel.reason ? ` · ${channel.reason}` : ''}</span><small>状态更新 {time(channel.at)}</small></li>)}</ul></details> : null}
    {report?.diagnostics.length ? <details className="panel blc-records blc-diagnostics"><summary>采集诊断（最近 {Math.min(50, report.diagnostics.length)} 条）</summary><ul className="blc-channels">{report.diagnostics.slice(-50).reverse().map((item, index) => <li key={`${item.at}:${index}`}><strong>{time(item.at)} · {item.venue ? venue(item.venue) : '采集服务'}</strong><span>{item.message}</span>{item.reason ? <small>{reasonText(item.reason)}</small> : null}</li>)}</ul></details> : null}
  </div>;
}

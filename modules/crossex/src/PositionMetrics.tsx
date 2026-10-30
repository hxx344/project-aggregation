import { lazy, Suspense } from 'react';
import Decimal from 'decimal.js';
import type { PositionGroup } from './live-types';
import type { PositionSample } from './position-history';
import { amountClass } from './live-display';
import { percentage } from './position-view';
import DecimalValue from './DecimalValue';
import { time } from './display';
import './position-metrics.css';

const PositionCharts = lazy(() => import('./PositionCharts'));
// Three fixed strategy rules, not an account risk assessment; scores and thresholds are unchanged.
const observedRules = [['spread_narrowing', '价差收窄超 30%'], ['holding_age', '持仓超 7 天'], ['funding_reversal', '当前净资金费为负']] as const;
const RULE_SCOPE = '仅观察这三项规则；保证金、强平价、ADL 需另行核对，流动性与执行敞口不在范围内';

export function holdingDuration(ms: number | null) {
  if (ms === null || ms < 0 || !Number.isFinite(ms)) return '—';
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return days ? `${days}天 ${hours % 24}小时` : hours ? `${hours}小时 ${minutes % 60}分` : `${minutes}分`;
}

export function PositionMetricsSummary({ group, stale }: { group: PositionGroup; stale: boolean }) {
  const m = group.metrics;
  return <div className="position-metrics-summary" aria-label={`${group.base} 组合指标`}>
    <div><span>综合年化收益率{stale && <small className="warning">旧值</small>}</span><strong className={amountClass(m.annualizedReturn)}>{percentage(m.annualizedReturn)}</strong><small>价差 + 累计资金费 / 当前保证金</small></div>
    <div><span>持仓时长</span><strong>{holdingDuration(m.holdingMs)}</strong><small>{m.openedAt ? `最早持仓腿 ${time(m.openedAt)}` : '交易所未提供完整开仓时间'}</small></div>
    <div title={RULE_SCOPE}><span>三项规则观察</span><strong className={`position-health ${stale ? 'unknown' : m.health}`}><i aria-hidden="true"/>{stale ? '数据待更新' : m.health === 'unknown' ? '待补全' : m.healthDeductions.length ? `触发 ${m.healthDeductions.length} 项` : '未触发'}{!stale && m.healthScore !== null && <small>{m.healthScore} / 100</small>}</strong><small>{stale ? '等待完整、新鲜的账户快照' : m.health === 'unknown' ? m.healthMissing.join('；') : `${observedRules.map(([code, label]) => { const hit = m.healthDeductions.find(item => item.code === code); return `${label} ${hit ? `触发（扣 ${hit.points}）` : '未触发'}`; }).join(' · ')}。${RULE_SCOPE}`}</small></div>
  </div>;
}

function Amount({ value, currency }: { value: string | null; currency: string | null }) {
  return <span className={amountClass(value)}><DecimalValue value={value} kind="amount" signed/> <small>{currency}</small></span>;
}

function countdown(at: number | null, now: number) {
  if (at === null) return '—';
  if (at <= now) return '等待新结算时间';
  const seconds = Math.ceil((at - now) / 1000), hours = Math.floor(seconds / 3600);
  return `${hours.toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function PositionMetricsDetails({ group, now, samples, stale }: { group: PositionGroup; now: number; samples: PositionSample[]; stale: boolean }) {
  const m = group.metrics;
  const chartValues = [m.spreadReturn, m.fundingFee];
  const canShowComposition = chartValues.every(value => value !== null && new Decimal(value).gte(0)) && chartValues.some(value => value !== null && new Decimal(value).gt(0));
  return <div className="position-metrics-details">
    {stale && <p className="metrics-note warning" role="status">快照待更新：保留已知收益和历史，不生成新的规则观察结论或趋势样本。</p>}
    <div className="position-detail-grid">
      <section className="position-detail-block" aria-label={`${group.base} 价差分析`}><h3>价差收益</h3>
        <dl className="position-metric-values">
          <div><dt>开仓价差</dt><dd>{percentage(m.entrySpread)}</dd></div>
          <div><dt>当前价差</dt><dd>{percentage(m.currentSpread)}</dd></div>
          <div><dt>价差收益</dt><dd><Amount value={m.spreadReturn} currency={m.currency}/></dd></div>
          <div><dt>价差收益率</dt><dd className={amountClass(m.spreadReturnRatio)}>{percentage(m.spreadReturnRatio)}</dd></div>
        </dl>
        <p className="metrics-note">价差 =（空头价格 − 多头价格）/ 多头价格；收益率以开仓多头名义额计，不含交易费。</p>
        <Suspense fallback={<p className="metrics-note">正在加载趋势…</p>}><PositionCharts kind="spread" samples={samples}/></Suspense>
      </section>
      <section className="position-detail-block" aria-label={`${group.base} 资金费分析`}><h3>资金费收益</h3>
        <dl className="position-metric-values">
          <div><dt>当前费率差（% / 8h）</dt><dd className={amountClass(m.fundingRate8h)}>{percentage(m.fundingRate8h)}</dd></div>
          <div><dt>预期年化费率</dt><dd className={amountClass(m.expectedFundingAnnualized)}>{percentage(m.expectedFundingAnnualized)}</dd></div>
          <div><dt>累计资金费（实收净额）</dt><dd><Amount value={m.fundingFee} currency={m.currency}/></dd></div>
          <div><dt>累计结算次数</dt><dd>— <small>交易所未提供</small></dd></div>
          <div><dt>累计资金费年化（实际）</dt><dd className={amountClass(m.realizedFundingAnnualized)}>{percentage(m.realizedFundingAnnualized)}</dd></div>
          <div><dt>下次结算倒计时</dt><dd>{countdown(m.nextFundingAt, now)}</dd></div>
        </dl>
        <p className="metrics-note">费率统一折算为 8 小时；预期年化 = 费率差 × 3 × 365。实际年化按当前保证金与持仓时长计算。正值为收取，负值为支付。</p>
        {m.fundingAsOf !== null && <p className="metrics-note">费率来源 {time(m.fundingAsOf)}；倒计时取两腿中最近的结算时间。</p>}
      </section>
    </div>
    {m.reasons.length > 0 && <p className="metrics-note metrics-missing">{m.reasons.join('；')}</p>}
    <details className="position-advanced"><summary>高级分析与计算口径</summary><div className="position-advanced-content">
      <dl className="position-metric-values">
        <div><dt>ROI（价差 + 资金费）</dt><dd className={amountClass(m.roi)}>{percentage(m.roi)}</dd></div>
        <div><dt>当前占用保证金</dt><dd><DecimalValue value={m.margin} kind="amount"/> <small>{m.currency}</small></dd></div>
        <div><dt>最大回撤</dt><dd>— <small>需要完整持仓净值历史</small></dd></div>
        <div><dt>资金费反转概率</dt><dd>— <small>缺少历史样本与概率模型</small></dd></div>
      </dl>
      <div className="position-composition"><h4>收益构成</h4><p><span>价差收益</span><Amount value={m.spreadReturn} currency={m.currency}/></p><p><span>资金费收益</span><Amount value={m.fundingFee} currency={m.currency}/></p><p><span>合计</span><Amount value={m.totalReturn} currency={m.currency}/></p>{canShowComposition ? <Suspense fallback={null}><PositionCharts kind="composition" values={[m.spreadReturn!, m.fundingFee!]}/></Suspense> : <small className="metrics-note">存在亏损、零收益或缺失项时，按带符号金额展示构成。</small>}</div>
      <p className="metrics-note metrics-method">综合年化 =（价差收益 + 累计资金费）/ 当前占用保证金 / 持仓天数 × 365，不含已实现盈亏与交易费。时长从最早的当前持仓腿计起，增减仓或保证金变化会影响指标，短时持仓的年化可能明显放大。三项规则观察从 100 分起：价差绝对幅度较开仓收窄超过 30% 扣 30 分，持仓超过 7 天扣 20 分，当前持仓方向净资金费为负扣 25 分；≥70、≥40、低于 40 分别以绿、黄、红标示。该分值只反映这三项规则，不是综合风险评估；当前净费率为负不代表已确认发生历史变号。</p>
    </div></details>
  </div>;
}

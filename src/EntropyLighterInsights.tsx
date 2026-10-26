import { ArrowRight, CircleCheck, Clock3 } from 'lucide-react';
import type { LabEvaluation, LabFeeFact, LabFeeSnapshot, LabInsights, LabReport, LabSymbol, LabSymbolInsight } from './entropy-lighter-types';

const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const percentage = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
function cash(value: number | null | undefined) { return typeof value === 'number' && Number.isFinite(value) ? `$${money.format(value)}` : '待确认'; }
function percent(bps: number | null | undefined) { return typeof bps === 'number' && Number.isFinite(bps) ? `${percentage.format(bps / 100)}%` : '比例待确认'; }
function venue(value: string) { return value === 'entropy' ? 'Entropy' : value === 'lighter' ? 'Lighter' : value; }
const feeTimes = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function feeTime(value: number | null | undefined) { return typeof value === 'number' && Number.isFinite(value) ? feeTimes.format(value) : '尚无记录'; }
function rate(value: number | null | undefined) { return typeof value === 'number' && Number.isFinite(value) ? `${percentage.format(value)} bps = ${percent(value)}` : '待获取'; }
function sourceUrl(value: string) { try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url : null; } catch { return null; } }
function currentAutomaticFee(snapshot: LabFeeSnapshot | undefined, serverNow: number | null, symbol: LabSymbol) {
  const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const currentTime = (fetchedAt: unknown, expiresAt: unknown) => nonnegative(fetchedAt) && nonnegative(expiresAt) && serverNow !== null && Number.isFinite(serverNow) && fetchedAt <= serverNow && expiresAt > serverNow;
  return snapshot?.mode === 'auto' && snapshot.symbol === symbol && snapshot.status === 'available'
    && typeof snapshot.revision === 'string' && !!snapshot.revision.trim() && currentTime(snapshot.fetchedAt, snapshot.expiresAt)
    && nonnegative(snapshot.takerBps?.entropy) && nonnegative(snapshot.takerBps?.lighter)
    && (['entropy', 'lighter'] as const).every(venue => {
      const fact = snapshot[venue];
      return fact?.status === 'available' && fact.takerFeeBps === snapshot.takerBps[venue] && currentTime(fact.fetchedAt, fact.expiresAt);
    });
}

function FeeSource({ name, fact }: { name: string; fact: LabFeeFact | null | undefined }) {
  const sources = (fact?.sourceUrls || []).map(sourceUrl).filter(url => url !== null);
  return <div className="el-fee-source"><strong>{name}</strong><span>更新 {feeTime(fact?.fetchedAt)}；有效至 {feeTime(fact?.expiresAt)}</span>{fact?.baseTakerBps !== null && fact?.baseTakerBps !== undefined ? <span>基础 taker {rate(fact.baseTakerBps)}{fact.growthMultiplier !== null ? `；增长倍率 ${percentage.format(fact.growthMultiplier)}` : ''}{fact.deployerFeeScale !== null ? `；部署者费率系数 ${percentage.format(fact.deployerFeeScale)}` : ''}</span> : null}<span>{sources.length ? sources.map((url, index) => <a key={`${url.href}:${index}`} href={url.href} target="_blank" rel="noreferrer">{url.hostname}{sources.length > 1 ? ` · 来源 ${index + 1}` : ''}</a>) : '来源待获取'}</span></div>;
}

function AutomaticFees({ snapshot, serverNow, symbol }: { snapshot?: LabFeeSnapshot; serverNow: number | null; symbol: LabSymbol }) {
  const expired = snapshot?.status === 'expired' || (typeof snapshot?.expiresAt === 'number' && serverNow !== null && serverNow >= snapshot.expiresAt);
  const ready = currentAutomaticFee(snapshot, serverNow, symbol);
  return <div className="el-automatic-fees"><div className="el-fee-heading"><strong>自动费用</strong><span className={`el-quality ${ready ? 'good' : 'pending'}`}>{ready ? '公开费用已获取' : expired ? '费用已过期，待刷新' : snapshot?.status === 'available' ? '费用状态待刷新' : '自动获取中'}</span></div><p>{!ready && snapshot ? '上次记录：' : ''}Entropy {rate(snapshot?.takerBps.entropy)}；Lighter Standard {rate(snapshot?.takerBps.lighter)}</p><details><summary>费用来源与更新时间</summary><FeeSource name="Entropy" fact={snapshot?.entropy} /><FeeSource name="Lighter Standard" fact={snapshot?.lighter} /></details></div>;
}

function RebateResults({ evaluation, delayed }: { evaluation: LabEvaluation | null | undefined; delayed: boolean }) {
  const locked = evaluation?.feeSnapshot;
  return <div className="el-rebate-results"><div className="el-rebate-heading"><strong>额外渠道返佣假设</strong><span>{delayed ? '基于上方延迟样本' : '基于入场样本，延迟待验证'}</span></div><dl>{([1.1, 1.2] as const).map(ratio => {
    const rebate = evaluation?.rebates?.find(row => row.ratio === ratio);
    return <div className="el-rebate-row" key={ratio}><dt>{Math.round(ratio * 100)}%</dt><dd><small>假设返佣</small><span>{cash(rebate?.contingentRebateCash)}</span></dd><dd><small>返佣后余量</small><span>{cash(rebate?.surplusCash)}</span></dd></div>;
  })}</dl><p>按 Entropy 整轮总手续费 {cash(evaluation?.entropyRoundTripFeesCash)} × 110% / 120% 分别计算，未到账。</p><p className="el-fee-lock">{locked ? `该样本锁定费用：Entropy ${rate(locked.takerBps.entropy)}；Lighter ${rate(locked.takerBps.lighter)}。版本 ${locked.revision?.slice(0, 12) || '未知'}，获取于 ${feeTime(locked.fetchedAt)}。` : evaluation ? '该历史样本未记录费用快照，费用来源未知；按原始报告展示，当前费率不用于重算。' : '等待带费用快照的评估样本。'}</p></div>;
}

function SymbolConclusion({ symbol, insight, historical, stopped, feeSnapshot, serverNow }: { symbol: LabSymbol; insight?: LabSymbolInsight; historical: boolean; stopped: boolean; feeSnapshot?: LabFeeSnapshot; serverNow: number | null }) {
  const current = !!insight && !historical;
  const candidate = current && insight.status === 'paper_candidate';
  const title = historical ? stopped ? '历史观测，等待新会话' : '观测待更新' : insight?.title || '等待新版采样';
  const reason = historical ? '保留上次研究记录；取得更新的报告后再判断策略。' : insight?.reason || '新版采集报告到达后，这里会解释价差是否覆盖成本与延迟。';
  const latestDelayed = insight?.bestDelayed?.latest;
  return <article className={`el-conclusion ${candidate ? 'candidate' : ''}`} aria-label={`${symbol} 研究结论`}>
    <div className="el-conclusion-heading"><h3>{symbol}</h3><span className={`el-conclusion-state ${candidate ? 'good' : ''}`}>{candidate ? <CircleCheck size={14} /> : <Clock3 size={14} />}{historical ? '历史记录' : candidate ? '仅供纸面验证' : '继续研究'}</span></div>
    <h4>{title}</h4><p className="el-conclusion-reason">{reason}</p>
    {insight?.direction ? <p className="el-direction"><span>买入 {venue(insight.direction.buy)}</span><ArrowRight size={15} /><span>卖出 {venue(insight.direction.sell)}</span><small>{historical ? '上次比较方向' : symbol === 'ANTH' ? '仅比较报价，待核验等价' : '当前研究方向'}</small></p> : null}
    <AutomaticFees snapshot={feeSnapshot} serverNow={serverNow} symbol={symbol} />
    <div className="el-budget-heading">{historical ? '历史样本预算' : '按报告会话金额估算'}<span>每腿约 {cash(insight?.notional.buyCash)} / {cash(insight?.notional.sellCash)} USD</span><span>一轮双边开平成交额约 {cash(insight?.notional.approxRoundTripTurnoverCash)}（示例）</span></div>
    <dl className="el-budget"><div><dt>入场价差</dt><dd>{cash(insight?.raw?.grossCash)}<small>{percent(insight?.raw?.grossBps)}，已计入场滑点</small></dd></div><div><dt>整轮成本预算</dt><dd>{cash(insight?.raw?.costs?.totalReserveCash)}<small>开平仓手续费、退出滑点与资金费预留</small></dd></div><div><dt>延迟后余量</dt><dd>{cash(latestDelayed?.surplusBeforeRebateCash)}<small>{latestDelayed ? `${percent(latestDelayed.surplusBeforeRebateBps)}，${insight?.bestDelayed?.scenario ? `Entropy ${percentage.format(insight.bestDelayed.scenario.entropyMs / 1000)}秒 / Lighter ${percentage.format(insight.bestDelayed.scenario.lighterMs / 1000)}秒` : '延迟情景'}` : '等待完整延迟样本'}</small></dd></div></dl>
    <RebateResults evaluation={latestDelayed || insight?.raw} delayed={!!latestDelayed} />
    <p className="el-budget-caveat">余量不是完整往返利润，仍需平仓时两侧价差收敛。返佣前为负的策略不会因假设返佣变为纸面候选。</p>
    {insight?.nextSteps?.length && current ? <div className="el-next-step"><strong>下一步</strong><p>{insight.nextSteps.join(' ')}</p></div> : <div className="el-next-step"><strong>下一步</strong><p>{stopped ? '启动新一轮采集，更新样本后再评估。' : historical ? '等待采集报告更新；也可展开明细检查最近连接记录。' : '继续采集，等待自动费用、合约身份与延迟样本就绪。'}</p></div>}
  </article>;
}

export default function EntropyLighterInsights({ insights, historical, stopped, report, reportAgeMs, serverNow }: { insights?: LabInsights; historical: boolean; stopped: boolean; report: LabReport | null; reportAgeMs: number | null; serverNow: number | null }) {
  const feesInvalid = (symbol: LabSymbol) => {
    const insight = insights?.bySymbol[symbol];
    if (report?.automaticFees?.mode !== 'auto' || !insight || !['paper_candidate', 'no_edge', 'latency_erases_edge', 'insufficient_samples'].includes(insight.status)) return false;
    const fee = report.automaticFees.bySymbol?.[symbol];
    if (!currentAutomaticFee(fee, serverNow, symbol)) return true;
    // Current source times establish freshness; an evaluation retains the source times from when it was locked.
    if (!insight.raw || insight.raw.feeSnapshot?.revision !== fee?.revision || insight.rawMetrics?.feeRevision !== fee?.revision) return true;
    return !!insight.bestDelayed && (!insight.bestDelayed.latest || insight.bestDelayed.latest.feeSnapshot?.revision !== fee?.revision || insight.bestDelayed.feeRevision !== fee?.revision);
  };
  const evidenceExpired = (symbol: LabSymbol) => {
    const insight = insights?.bySymbol[symbol];
    if (!insight || !['paper_candidate', 'no_edge', 'latency_erases_edge'].includes(insight.status)) return false;
    const silence = report?.observation?.silenceAfterMs;
    const evidenceMaxAgeMs = insights?.evidenceMaxAgeMs;
    const sampleTimes = [insight.raw?.at, ...(insight.bestDelayed?.latest ? [insight.bestDelayed.latest.at] : [])];
    if (typeof evidenceMaxAgeMs !== 'number' || !Number.isFinite(evidenceMaxAgeMs) || evidenceMaxAgeMs <= 0 || serverNow === null || reportAgeMs === null) return true;
    if (sampleTimes.some(at => typeof at !== 'number' || !Number.isFinite(at) || serverNow - at > evidenceMaxAgeMs || at - serverNow > 100)) return true;
    if (insight.status !== 'paper_candidate') return false;
    if (typeof silence !== 'number' || !Number.isFinite(silence) || silence <= 0) return true;
    if (insight.bestDelayed?.latest?.sourceTimeUncertain !== false) return true;
    return ['entropy', 'lighter'].some(source => {
      const quote = report?.latestQuotes.find(q => q.symbol === symbol && q.venue === source);
      return !quote || (quote.executionQuality !== null && quote.executionQuality !== 'stale_receive' && quote.executionQuality !== 'stale_source') || quote.sourceClockUncertain !== false || typeof quote.receiveAgeMs !== 'number' || !Number.isFinite(quote.receiveAgeMs) || quote.receiveAgeMs < 0 || quote.receiveAgeMs + reportAgeMs > silence;
    });
  };
  const expired = (['SNDK', 'ANTH'] as const).some(symbol => evidenceExpired(symbol) || feesInvalid(symbol));
  return <section className="panel el-insights" aria-label="策略研究结论"><div className="el-insights-intro"><div><h2>{historical ? '观测保留，暂缓策略判断' : expired ? '部分观测待更新' : insights?.summary.title || '先看观测结果'}</h2><p>{historical ? '以下金额是上次样本记录，当前不作套利建议。' : expired ? '最近研究证据、行情或费用版本待刷新，等待新报告后再判断。' : insights?.summary.reason || '把价差换成金额，再看成本与延迟会留下多少空间。'}</p></div><span>USD 研究口径</span></div>
    <p className="el-fee-scope">费用采用公开默认档，不含账户个别折扣，按无 builder 加费的 API 研究情景估算；不代表账户实付。无需填写费用或返佣比例。</p>
    <div className="el-conclusions">{(['SNDK', 'ANTH'] as const).map(symbol => <SymbolConclusion key={symbol} symbol={symbol} insight={insights?.bySymbol[symbol]} historical={historical || evidenceExpired(symbol) || feesInvalid(symbol)} stopped={stopped} feeSnapshot={report?.automaticFees?.bySymbol[symbol]} serverNow={serverNow} />)}</div>
    <div className="el-leader-conclusion"><strong>{insights?.leader.title || '领先策略待验证'}</strong><p>{insights?.leader.reason || 'Binance 只用于观察相关反应。接收先后与方向命中不能证明可交易的领先优势。'}</p><span>ANTH 合约身份和经济等价尚未核验，先不推荐跨所收敛套利。</span></div>
  </section>;
}

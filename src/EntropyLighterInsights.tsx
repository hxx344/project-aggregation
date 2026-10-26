import { ArrowRight, CircleCheck, Clock3 } from 'lucide-react';
import type { LabInsights, LabReport, LabSymbol, LabSymbolInsight } from './entropy-lighter-types';

const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const percentage = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
function cash(value: number | null | undefined) { return typeof value === 'number' && Number.isFinite(value) ? `$${money.format(value)}` : '待确认'; }
function percent(bps: number | null | undefined) { return typeof bps === 'number' && Number.isFinite(bps) ? `${percentage.format(bps / 100)}%` : '比例待确认'; }
function venue(value: string) { return value === 'entropy' ? 'Entropy' : value === 'lighter' ? 'Lighter' : value; }

function SymbolConclusion({ symbol, insight, historical, stopped }: { symbol: LabSymbol; insight?: LabSymbolInsight; historical: boolean; stopped: boolean }) {
  const current = !!insight && !historical;
  const candidate = current && insight.status === 'paper_candidate';
  const title = historical ? stopped ? '历史观测，等待新会话' : '观测待更新' : insight?.title || '等待新版采样';
  const reason = historical ? '保留上次研究记录；取得更新的报告后再判断策略。' : insight?.reason || '新版采集报告到达后，这里会解释价差是否覆盖成本与延迟。';
  const latestDelayed = insight?.bestDelayed?.latest;
  return <article className={`el-conclusion ${candidate ? 'candidate' : ''}`} aria-label={`${symbol} 研究结论`}>
    <div className="el-conclusion-heading"><h3>{symbol}</h3><span className={`el-conclusion-state ${candidate ? 'good' : ''}`}>{candidate ? <CircleCheck size={14} /> : <Clock3 size={14} />}{historical ? '历史记录' : candidate ? '仅供纸面验证' : '继续研究'}</span></div>
    <h4>{title}</h4><p className="el-conclusion-reason">{reason}</p>
    {insight?.direction ? <p className="el-direction"><span>买入 {venue(insight.direction.buy)}</span><ArrowRight size={15} /><span>卖出 {venue(insight.direction.sell)}</span><small>{historical ? '上次比较方向' : symbol === 'ANTH' ? '仅比较报价，待核验等价' : '当前研究方向'}</small></p> : null}
    <div className="el-budget-heading">{historical ? '历史样本预算' : '按报告会话金额估算'}<span>每腿约 {cash(insight?.notional.buyCash)} / {cash(insight?.notional.sellCash)} USD</span><span>一轮双边开平成交额约 {cash(insight?.notional.approxRoundTripTurnoverCash)}（示例）</span></div>
    <dl className="el-budget"><div><dt>入场价差</dt><dd>{cash(insight?.raw?.grossCash)}<small>{percent(insight?.raw?.grossBps)}，已计入场滑点</small></dd></div><div><dt>整轮成本预算</dt><dd>{cash(insight?.raw?.costs?.totalReserveCash)}<small>开平仓手续费、退出滑点与资金费预留</small></dd></div><div><dt>延迟后余量</dt><dd>{cash(latestDelayed?.surplusBeforeRebateCash)}<small>{latestDelayed ? `${percent(latestDelayed.surplusBeforeRebateBps)}，${insight?.bestDelayed?.scenario ? `Entropy ${percentage.format(insight.bestDelayed.scenario.entropyMs / 1000)}秒 / Lighter ${percentage.format(insight.bestDelayed.scenario.lighterMs / 1000)}秒` : '延迟情景'}` : '等待完整延迟样本'}</small></dd></div></dl>
    <p className="el-budget-caveat">余量不是完整往返利润，仍需平仓时两侧价差收敛。返佣是假设，未计为到账收益。</p>
    {insight?.nextSteps?.length && current ? <div className="el-next-step"><strong>下一步</strong><p>{insight.nextSteps.join(' ')}</p></div> : <div className="el-next-step"><strong>下一步</strong><p>{stopped ? '启动新一轮采集，更新样本后再评估。' : historical ? '等待采集报告更新；也可展开明细检查最近连接记录。' : '继续采集，先核实费用、合约身份与延迟样本。'}</p></div>}
  </article>;
}

export default function EntropyLighterInsights({ insights, historical, stopped, report, reportAgeMs, serverNow }: { insights?: LabInsights; historical: boolean; stopped: boolean; report: LabReport | null; reportAgeMs: number | null; serverNow: number | null }) {
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
  const expired = (['SNDK', 'ANTH'] as const).some(evidenceExpired);
  return <section className="panel el-insights" aria-label="策略研究结论"><div className="el-insights-intro"><div><h2>{historical ? '观测保留，暂缓策略判断' : expired ? '部分观测待更新' : insights?.summary.title || '先看观测结果'}</h2><p>{historical ? '以下金额是上次样本记录，当前不作套利建议。' : expired ? '最近研究证据或行情已超出观察窗口，等待新报告后再判断。' : insights?.summary.reason || '把价差换成金额，再看成本与延迟会留下多少空间。'}</p></div><span>USD 研究口径</span></div>
    <div className="el-conclusions">{(['SNDK', 'ANTH'] as const).map(symbol => <SymbolConclusion key={symbol} symbol={symbol} insight={insights?.bySymbol[symbol]} historical={historical || evidenceExpired(symbol)} stopped={stopped} />)}</div>
    <div className="el-leader-conclusion"><strong>{insights?.leader.title || '领先策略待验证'}</strong><p>{insights?.leader.reason || 'Binance 只用于观察相关反应。接收先后与方向命中不能证明可交易的领先优势。'}</p><span>ANTH 合约身份和经济等价尚未核验，先不推荐跨所收敛套利。</span></div>
  </section>;
}

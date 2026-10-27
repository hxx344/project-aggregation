import type { LabBinanceScalper, LabReport, LabScalperScenario, LabScalperTrade, LabSymbol } from './entropy-lighter-types';

const symbols: LabSymbol[] = ['SNDK', 'ANTH'];
const numbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const times = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const stageLabels: Record<LabScalperScenario['state'], string> = {
  waiting: '等待研究条件', armed: '双向条件已冻结', entry_pending: '等待模拟开仓', holding: '模拟持仓中',
  exit_pending: '等待模拟平仓', cooldown: '冷却后重新布置', unresolved: '未决敞口，停止新增信号',
};
const reasonLabels: Record<string, string> = {
  waiting_leader: '等待 Binance 有效盘口。', leader_metadata_unavailable: 'Binance 合约资料暂不可用。',
  leader_unavailable: 'Binance 方向来源暂不可用。', leader_depth_unavailable: '等待 Binance 至少四档有效盘口。',
  entropy_metadata_unavailable: 'Entropy 合约资料暂不可用。', entropy_unavailable: '等待 Entropy 有效成交盘口。',
  entropy_fee_unavailable: '等待自动取得 Entropy 公开费用。', entropy_fee_expired: 'Entropy 费用已过期，等待自动刷新。',
  entry_timeout: '开仓等待超时，本次没有建立完整模拟持仓。', exit_timeout: '平仓等待超时，退出价格与总收益未知。',
  insufficient_depth: '公开盘口深度不足，无法确认模拟成交。', minimum_order_size: '模拟数量未达到合约最小要求。',
  recross_trigger: '反穿原触发价', hold_timeout: '达到最长持有时间', leader_invalid: 'Binance 方向来源失效',
};
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function num(value: number | null | undefined) { return finite(value) ? numbers.format(value) : '未知'; }
function cash(value: number | null | undefined) { return finite(value) ? money.format(value) : '未知'; }
function time(value: number | null | undefined) { return finite(value) && value > 0 ? times.format(value) : '尚无记录'; }
function outcome(trade: LabScalperTrade) {
  if (trade.outcome === 'unresolved') return '未决退出';
  if (trade.outcome === 'failed_entry') return '未完成开仓';
  return reasonLabels[trade.exitReason || ''] || '已平仓';
}
function exposure(scenario: LabScalperScenario) {
  return scenario.stats.hasOpenExposure || scenario.stats.unresolved > 0 || scenario.position !== null || ['entry_pending', 'holding', 'exit_pending', 'unresolved'].includes(scenario.state);
}
function conclusion(scenarios: LabScalperScenario[], historical: boolean, stopped: boolean, suspended: boolean) {
  if (stopped) return '采集已停止，保留历史研究';
  if (historical) return '观测待更新，当前阶段待确认';
  if (scenarios.some(s => s.state === 'unresolved' || s.stats.unresolved > 0)) return '存在未决敞口，暂不适合实盘';
  if (suspended) return '研究暂停新增信号';
  if (scenarios.some(exposure)) return '模拟敞口尚未闭合，总收益未知';
  if (!scenarios.length || scenarios.some(s => s.stats.completed === 0)) return '尚无足够已平样本，仅可继续模拟';
  if (scenarios.some(s => finite(s.stats.netBeforeRebate) && s.stats.netBeforeRebate < 0)) return '返佣前仍有亏损，仅可继续模拟';
  return '领先关系仍待验证，仅可继续模拟';
}

function Scenario({ scenario, historical, suspended, scope }: { scenario: LabScalperScenario; historical: boolean; suspended: boolean; scope: '本会话' | '上次会话' }) {
  const { stats, position, armed } = scenario;
  const unknown = suspended || exposure(scenario), trades = scenario.recentTrades.slice(-8).reverse();
  const stage = stageLabels[scenario.state];
  const cause = reasonLabels[scenario.reason || ''];
  const rebates = [1.1, 1.2].map(ratio => stats.rebateScenarios.find(value => value.ratio === ratio));
  const lossRate = stats.completed > 0 ? `${num(stats.lossesBeforeRebate / stats.completed * 100)}%` : '暂无已平样本';
  return <article className="el-scalper-scenario" aria-label={`${scenario.entropyMs} ms 延迟情景`}>
    <header className="el-scalper-scenario-heading"><h3>Entropy 延迟 {num(scenario.entropyMs)} ms</h3><span>开仓 / 平仓分别延迟</span></header>
    <div className={`el-scalper-stage ${scenario.state === 'unresolved' ? 'alert' : ''}`}>
      <strong>{historical ? '最近记录 · ' : suspended ? '已暂停 · ' : ''}{stage}</strong>
      {cause ? <p>{cause}</p> : <p>{position ? `${position.direction === 'long' ? '做多' : '做空'}已触发，反向条件已撤销。` : scenario.state === 'armed' ? '虚拟 OCO：一侧突破开仓，另一侧条件同时撤销。' : scenario.state === 'cooldown' ? '本轮结束后等待冷却，再冻结新一轮第4档价格。' : '有效盘口和费用就绪后自动布置，无需启用跨所模拟。'}</p>}
    </div>
    <dl className="el-scalper-triggers">
      <div><dt>冻结上沿 · Binance 卖4（USDT）</dt><dd>{num(armed?.upper)}<small>{armed ? `冻结于 ${time(armed.at)}` : '本轮尚未冻结或已撤销'}</small></dd></div>
      <div><dt>冻结下沿 · Binance 买4（USDT）</dt><dd>{num(armed?.lower)}<small>{position ? `原触发价 ${num(position.triggerPrice)} USDT` : '冻结后不随盘口移动'}</small></dd></div>
    </dl>
    {position ? <p className="el-scalper-position">Entropy {position.direction === 'long' ? '做多' : '做空'} · 模拟入场价 {cash(position.entryPrice)} · 数量 {num(position.quantity)}。{position.direction === 'long' ? 'Binance 买1回落到原上沿下方退出。' : 'Binance 卖1回升到原下沿上方退出。'}</p> : null}
    <dl className="el-scalper-metrics">
      <div><dt>已平样本</dt><dd>{num(stats.completed)} <small className="el-scalper-unit">笔</small></dd></div>
      <div><dt>返佣前亏损占比</dt><dd>{lossRate}<small>{num(stats.lossesBeforeRebate)} 笔亏损 / {num(stats.completed)} 笔已平</small></dd></div>
      <div><dt>{scope}模拟成交额（Entropy）</dt><dd>{cash(stats.turnover)}<small>已知开仓 + 平仓名义金额</small></dd></div>
      <div><dt>{scope}返佣前净收益</dt><dd className={unknown ? 'pending' : finite(stats.netBeforeRebate) && stats.netBeforeRebate < 0 ? 'negative' : ''}>{unknown ? '未知' : cash(stats.netBeforeRebate)}<small>{unknown ? '暂停或存在未闭合敞口，不能只看已平收益' : '已扣两次手续费、滑点与资金费预留'}</small></dd></div>
    </dl>
    <div className="el-scalper-rebates"><p><strong>全部 Entropy 手续费返佣情景</strong><span>未到账的假设返佣</span></p><dl>{rebates.map((rebate, index) => <div key={index}><dt>{scope} {index === 0 ? '110%' : '120%'} 后净收益</dt><dd>{unknown ? '未知' : cash(rebate?.net)}<small>假设返佣 {cash(rebate?.contingentRebate)}</small></dd></div>)}</dl></div>
    <p className="el-scalper-costs">已知手续费 {cash(stats.fees)} · 资金费等预留 {cash(stats.costReserve)} · 开仓失败 {num(stats.failedEntries)} 次 · 未决 {num(stats.unresolved)} 笔</p>
    <details className="el-scalper-trades"><summary>最近交易与退出原因<span>{trades.length} 条记录 · 仅此延迟情景</span></summary><div className="el-table-scroll" tabIndex={0} role="region" aria-label={`${scenario.entropyMs} ms 最近模拟交易`}><table className="el-table"><caption>逐笔模拟结果；未决记录的收益保留未知</caption><thead><tr><th scope="col">时间 / 方向</th><th scope="col">Entropy 入场 → 退出</th><th scope="col">退出原因 / 持有</th><th scope="col">返佣前</th><th scope="col">110% / 120% 后</th></tr></thead><tbody>{trades.length ? trades.map(trade => <tr key={trade.id}><th scope="row">{time(trade.at)}<small>{trade.direction === 'long' ? '做多' : '做空'}</small></th><td>{cash(trade.entryPrice)} → {cash(trade.exitPrice)}</td><td>{outcome(trade)}<small>{finite(trade.durationMs) ? `${num(trade.durationMs / 1000)} 秒` : '持有时长未知'}</small></td><td>{trade.outcome === 'completed' ? cash(trade.netBeforeRebate) : '未知'}<small>手续费 {cash(trade.fees)}</small></td><td>{[1.1, 1.2].map(ratio => <small key={ratio}>{ratio === 1.1 ? '110%' : '120%'}：{trade.outcome === 'completed' ? cash(trade.rebateScenarios.find(value => value.ratio === ratio)?.net) : '未知'}</small>)}</td></tr>) : <tr><td colSpan={5} className="el-table-empty">尚无已结束的模拟交易</td></tr>}</tbody></table></div></details>
  </article>;
}

function Policy({ strategy, symbol }: { strategy: LabBinanceScalper; symbol: LabSymbol }) {
  return <details className="el-scalper-policy"><summary>触发、成交与成本口径</summary><p>冻结 Binance 卖4为上沿、买4为下沿。买1从上沿下方穿到上沿及以上时模拟做多；卖1从下沿上方穿到下沿及以下时模拟做空。回穿原触发价、最长持有 {num(strategy.policy.maxHoldMs / 1000)} 秒或 Binance 来源失效时退出；冷却 {num(strategy.policy.cooldownMs / 1000)} 秒后重新冻结。</p><p>每笔名义金额 {cash(strategy.policy.notionalPerTrade)}；只在 Entropy 按公开盘口模拟 taker 成交，每次滑点 {num(strategy.policy.slippageBpsPerFill)} bps，单个头寸整轮资金费预留 {num(strategy.policy.fundingReserveBpsPerRoundTrip)} bps。进出场分别应用假设下单延迟，公开盘口是成交代理，不代表实际成交。</p><p>费用自动获取，并在每笔模拟锁定版本；扣开仓与平仓两次费用。110% / 120% 按用户渠道假设对全部 Entropy 手续费计算，未计为到账收益。各延迟情景采用互斥假设，结果不可相加。</p><p>{symbol === 'ANTH' ? 'ANTH 两地价位不同，仅取 Binance 方向，不做跨所价位相减。' : 'Binance 只提供方向触发，不建立 Binance 头寸。'} 本策略不使用 Lighter 作为第二腿；领先关系与实盘可执行性仍待验证。</p></details>;
}

export default function EntropyBinanceScalper({ report, symbol, onSymbol, historical, stopped, reportAgeMs, serverNow }: {
  report: LabReport | null; symbol: LabSymbol; onSymbol: (symbol: LabSymbol) => void;
  historical: boolean; stopped: boolean; reportAgeMs: number | null; serverNow: number | null;
}) {
  const strategy = report?.binanceScalper;
  const scenarios = Object.values(strategy?.bySymbol[symbol]?.scenarios || {});
  const old = historical || reportAgeMs === null || serverNow === null || !finite(strategy?.observedAt) || strategy.observedAt > serverNow || serverNow - strategy.observedAt > 15_000;
  const suspended = !!strategy?.suspendedReason || strategy?.enabled === false;
  const title = strategy?.previousSession ? '前次会话暂停，待核对历史敞口' : strategy ? conclusion(scenarios, old, stopped, suspended) : '等待首份方向研究报告';
  return <section className="panel el-scalper" aria-label="Binance 第4档方向研究">
    <header className="el-scalper-heading"><div><span className="el-scalper-eyebrow">BINANCE → ENTROPY · 方向研究</span><h2>第4档突破，在 Entropy 模拟跟随</h2></div><div className="el-symbols" role="group" aria-label="方向研究标的">{symbols.map(value => <button key={value} type="button" className={value === symbol ? 'active' : ''} aria-pressed={value === symbol} onClick={() => onSymbol(value)}>{value}</button>)}</div></header>
    <div className="el-scalper-conclusion" role="status"><h3>{title}</h3>{strategy?.previousSession ? <p>当前显示上次会话 {strategy.previousSession.session} 的保留记录；未恢复执行，总收益未知。请先核对历史敞口。</p> : null}<p>{strategy ? `${old ? '保留的采样' : '最近采样'} ${time(strategy.observedAt)}。各延迟情景分别研究；领先关系尚未证实，样本均值与返佣情景不能保证盈利。` : '启动采集后自动运行方向模拟，无需另开跨所四腿模拟或手填费率。旧报告不会被补成当前信号。'}</p></div>
    {strategy ? <><p className="el-scalper-scope">仅在 Entropy 模拟 taker · 假设下单延迟 · 返佣未到账{symbol === 'ANTH' ? ' · ANTH 只看 Binance 方向，不比较两地价位' : ''}。统计限定所示会话，正常重启开始新会话，旧逐笔事件保留。</p><div className="el-scalper-scenarios">{scenarios.length ? scenarios.map(scenario => <Scenario key={scenario.name} scenario={scenario} historical={old} suspended={suspended} scope={strategy.previousSession ? '上次会话' : '本会话'} />) : <p className="el-scalper-empty">{symbol} 暂无延迟情景，等待采集器生成报告。</p>}</div><Policy strategy={strategy} symbol={symbol} /></> : null}
  </section>;
}

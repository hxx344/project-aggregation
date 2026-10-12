import { format, signedClass } from './display';
import type { Funding, Position } from './types';

export default function PnlBreakdown({ value, entryFees, funding, title = '收益明细', staleReason }: {
  value: Position['valuation'] | Position['result']; entryFees: number; funding?: Funding; title?: string; staleReason?: string;
}) {
  return <details className="position-detail pnl-detail">
    <summary>{title}</summary>
    {staleReason && <p className="detail-note warning">保留上次估值明细：{staleReason}</p>}
    <dl className="pnl-grid">
      <div><dt>毛价格损益 · 按实际结算汇率</dt><dd className={signedClass(value?.gross)}>{format(value?.gross, 4)} USDT</dd></div>
      <div><dt>毛价格损益 · 按入场参考汇率</dt><dd>{format(value?.grossAtEntryFx, 4)} USDT</dd></div>
      <div><dt>其中：汇率折算影响</dt><dd className={signedClass(value?.fxImpact)}>{format(value?.fxImpact, 4)} USDT</dd></div>
      <div><dt>已记入场手续费</dt><dd>{format(entryFees, 4)} USDT</dd></div>
      <div><dt>退出手续费</dt><dd>{format(value?.exitFees, 4)} USDT</dd></div>
      <div><dt>扣费后价差盈亏</dt><dd className={signedClass(value?.net)}>{format(value?.net, 4)} USDT</dd></div>
      <div><dt>完整已确认资金费</dt><dd className={signedClass(funding?.confirmed)}>{format(funding?.confirmed, 4)} USDT</dd></div>
      <div><dt>含确认资金费净盈亏</dt><dd className={signedClass(value?.netWithFunding)}>{format(value?.netWithFunding, 4)} USDT</dd></div>
    </dl>
    <p className="detail-note">净盈亏 = 毛价格损益 − 入场手续费 − 退出手续费 + 已确认资金费。汇率折算影响是同一毛价格损益按实际结算汇率与入场参考汇率折算的差额，已含于毛价格损益，不重复加减，也不是本金换汇损益。持仓明细中的退出费用为估值；平仓记录使用实际模拟成交费用。</p>
    {funding?.status !== 'complete' && <p className="detail-note warning">资金费未完整确认，含资金费净盈亏保留缺失；已知部分与估算值不能替代完整结算。</p>}
  </details>;
}

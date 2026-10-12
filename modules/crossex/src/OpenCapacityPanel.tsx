import DecimalValue from './DecimalValue';
import { time, venue } from './display';
import { useOpenCapacity } from './use-open-capacity';
import type { CapacityContext } from './use-open-capacity';
import type { OpenCapacityInput } from './open-capacity';
import './open-capacity.css';

export default function OpenCapacityPanel({ input, context, base, pair = false }: {
  input: OpenCapacityInput | null; context: CapacityContext; base: string; pair?: boolean;
}) {
  const { data, error, loading } = useOpenCapacity(input, context);
  const available = data?.status === 'ready';
  const reason = error || data?.reason;
  const limitingFactors = data?.limitingFactors.map(factor => data.legs.reduce((label, leg) => label.replace(leg.symbol,
    `${venue(leg.symbol.split('_')[0].toLowerCase())} ${data.base}/${leg.quoteCurrency}`), factor));
  return <section className="open-capacity" aria-label="开仓额度估算" aria-busy={loading}>
    <div className="capacity-heading"><h3>预计最大可开{pair ? ' / 每腿' : ''}</h3><span>{loading ? '读取中' : available ? '已估算' : data?.status === 'blocked' ? '不可开仓' : '待核实'}</span></div>
    <div className="capacity-maximum"><strong><DecimalValue value={data?.status === 'blocked' ? '0' : available ? data.maxQuantity : null} full/></strong><span>{base || '—'}</span></div>
    <p className="capacity-notional">{pair ? '双腿合计名义额' : '对应名义额'} <DecimalValue value={data?.status === 'blocked' ? '0' : available ? data.maxNotionalUSDT : null} kind="amount"/> USDT</p>
    {reason && <p className="capacity-state warning" role="status">{reason}</p>}
    {data?.legs.length ? <div className="capacity-legs">{data.legs.map(leg => <div className="capacity-leg" key={leg.symbol}>
      <div className="capacity-leg-name"><strong>{venue(leg.symbol.split('_')[0].toLowerCase())}</strong><span>{leg.side === 'BUY' ? '做多' : '做空'} · {leg.quoteCurrency}</span></div>
      <dl><div><dt>预计杠杆</dt><dd><DecimalValue value={leg.leverage} kind="rate"/>{leg.leverage ? '×' : ''}</dd></div><div><dt>本单档位最高</dt><dd><DecimalValue value={leg.maxLeverage} kind="rate"/>{leg.maxLeverage ? '×' : ''}</dd></div>
        <div><dt>本单预计保证金</dt><dd><DecimalValue value={leg.requiredMargin} kind="amount"/> <small>USDT</small></dd></div>
        {context.live.account?.account_mode === 'ISOLATED_EXCHANGE' && <div><dt>该所可用保证金</dt><dd><DecimalValue value={leg.availableMargin} kind="amount"/> <small>USDT</small></dd></div>}
      </dl>
    </div>)}</div> : <p className="capacity-empty">预计杠杆 — · 本单档位最高 —</p>}
    {pair && <div className="capacity-total"><span>本单合计保证金</span><strong><DecimalValue value={data?.requiredMargin} kind="amount"/> <small>USDT</small></strong></div>}
    {data?.inputWithinCapacity === false && <p className="capacity-state warning" role="status">当前数量超出可开范围或不满足合约数量要求。</p>}
    {limitingFactors?.length ? <p className="capacity-limits">当前限制：{limitingFactors.join('、')}</p> : null}
    {data?.notes.map(note => <p className="capacity-note" key={note}>{note}</p>)}
    <p className="capacity-note">沿用账户当前杠杆；保证金含 10% 预留。{pair ? '两腿共用资金时合并计算。' : ''}最终以开仓预览校验为准。</p>
    {data && <small className="capacity-time">数据来源 {time(data.asOf)}</small>}
  </section>;
}

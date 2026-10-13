import { adlRedLights } from './adl-indicator';
import type { AdlRank } from './adl-indicator';
import { time, venue } from './display';
import './adl-indicator.css';

const LIGHTS = [0, 1, 2, 3, 4];

function AdlRow({ label, name, rank, lights, stale }: {
  label: string; name: string; rank: AdlRank; lights: number | null; stale: boolean;
}) {
  const missing = rank == null || typeof rank === 'string' && !rank.trim();
  const status = lights === null ? (missing ? '暂无数据' : '规则未确认') : `${lights}/5 红灯`;
  return <div className="adl-level-row" title={`${name} · 原始等级 ${rank ?? '—'}${stale ? ' · 上次数据，等待更新' : ''}`}>
    <span className="adl-source">{label}</span>
    <span className="adl-lamps" role="img" aria-label={`${name} ADL：${status}${stale ? '，数据待更新' : ''}`}>
      {LIGHTS.map(index => <i key={index} className={lights === null ? 'adl-lamp unknown' : index < lights ? 'adl-lamp red' : 'adl-lamp green'} />)}
    </span>
    <span className="adl-count">{lights === null ? '—' : `${lights}/5`}</span>
    {lights === null && <small className="adl-unavailable">{status}</small>}
  </div>;
}

export default function AdlIndicator({ exchange, internalRank, exchangeRank, stale = false, asOf }: {
  exchange: string; internalRank: AdlRank; exchangeRank: AdlRank; stale?: boolean; asOf?: number | null;
}) {
  return <div className="adl-indicator" title={`ADL 来源时间：${time(asOf)}`}>
    <AdlRow label="上游" name={venue(exchange)} rank={exchangeRank} lights={adlRedLights(exchangeRank, 'exchange', exchange)} stale={stale}/>
    <AdlRow label="内部" name="CrossEx 内部" rank={internalRank} lights={adlRedLights(internalRank, 'crossex')} stale={stale}/>
    <small className="adl-legend">红灯越多，减仓优先级越高</small>
    <small className="adl-sequence">上游触发后，按内部排名减仓</small>
    {stale && <small className="adl-stale">上次等级 · 等待更新</small>}
  </div>;
}

import { useMemo } from 'react';
import type { Instrument } from './live-types';
import { venue } from './display';
import './hedge-leg-selector.css';

export default function HedgeLegSelector({ instruments, value, onChange, label }: {
  instruments: Instrument[]; value: string; onChange: (symbol: string) => void; label: string;
}) {
  const current = instruments.find(instrument => instrument.symbol === value);
  const exchanges = useMemo(() => Array.from(new Set(instruments.map(instrument => instrument.exchange))), [instruments]);
  const contracts = instruments.filter(instrument => instrument.exchange === current?.exchange);
  return <div className="hedge-leg-selector">
    <label>交易所<select aria-label={`${label}交易所`} value={current?.exchange || ''} disabled={!exchanges.length}
      onChange={event => {
        const choices = instruments.filter(instrument => instrument.exchange === event.target.value);
        const next = choices.find(instrument => instrument.quoteCurrency === current?.quoteCurrency) || choices[0];
        if (next) onChange(next.symbol);
      }}>
      {!current && <option value="">选择交易所</option>}
      {exchanges.map(exchange => <option key={exchange} value={exchange}>{venue(exchange)}</option>)}
    </select></label>
    <label>计价币<select aria-label={`${label}计价币`} value={current?.symbol || ''} disabled={!contracts.length}
      onChange={event => onChange(event.target.value)}>
      {!current && <option value="">选择计价币</option>}
      {contracts.map(instrument => <option key={instrument.symbol} value={instrument.symbol}>{instrument.quoteCurrency}</option>)}
    </select></label>
  </div>;
}

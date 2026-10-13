import { useState } from 'react';
import type { CloseLeg, Instrument, LiveView } from './live-types';
import AccountBalances from './AccountBalances';
import PositionsPanel from './PositionsPanel';
import AccountHistory from './AccountHistory';

export default function PortfolioPanel({ live, instruments, disabled, close }: { live: LiveView; instruments: Instrument[]; disabled: boolean; close: (positions: CloseLeg[]) => Promise<boolean> }) {
  const [tab, setTab] = useState('positions');
  return <><div className="panel-tabs portfolio-tabs" role="tablist" aria-label="账户明细">{[['positions', '持仓组合'], ['balances', '账户资产'], ['trades', '真实成交'], ['book', '资金流水']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'positions' && <span className="count">{live.positions.length}</span>}</button>)}</div>
    {tab === 'positions' && <PositionsPanel live={live} instruments={instruments} disabled={disabled} close={close}/>}
    {tab === 'balances' && <AccountBalances balances={live.balances}/>}
    {(tab === 'trades' || tab === 'book') && <AccountHistory key={`${tab}:${live.connection.version}`} live={live} kind={tab}/>}
  </>;
}

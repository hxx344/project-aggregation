import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowLeftRight, Bot, ChartLine, Link2, LoaderCircle, Wallet } from 'lucide-react';
import type { TradingCache } from './trading-cache';
import { TRADING_SECTIONS } from './trading-sections';
import { readTradingSection, saveTradingSection } from './trading-navigation';
import { readTradingDays, readTradingPair } from './trading-preferences';
import type { TradingSection } from './trading-sections';
import TradingPositions from './TradingPositions';
import './trading-center.css';

// Hover/focus preloading and the lazy route share one request; a failed load is cleared so the next attempt retries.
let oilPage: Promise<typeof import('./OilTradingPage')> | null = null;
function loadOilPage() {
  oilPage ??= import('./OilTradingPage').catch(error => { oilPage = null; throw error; });
  return oilPage;
}
function preloadOilPage() { loadOilPage().catch(() => {}); }
const OilTradingPage = lazy(loadOilPage);
const icons: Record<TradingSection, typeof Wallet> = { positions: Wallet, trade: ArrowLeftRight, pnl: ChartLine, auto: Bot, accounts: Link2 };

export default function TradingPage({ cache, onExpired, onProject, navigationSearch }: {
  cache: TradingCache; onExpired: () => void; onProject: (id: string) => void; navigationSearch: string;
}) {
  const [section, setSection] = useState(() => readTradingSection(location.search));
  // The arbitrage tabs mount on first visit and then stay mounted (hidden) for the rest of the visit,
  // so opening the trading center on 全部仓位 does not start the arbitrage reads.
  const [arbitrageOpened, setArbitrageOpened] = useState(section !== 'positions');
  useEffect(() => { setSection(readTradingSection(location.search)); }, [navigationSearch]);
  useEffect(() => { saveTradingSection(section); }, [section]);
  useEffect(() => { if (section !== 'positions') setArbitrageOpened(true); }, [section]);
  useEffect(() => {
    const back = () => setSection(readTradingSection(location.search));
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  function select(next: TradingSection) {
    if (next === section) return;
    const url = new URL(location.href);
    url.searchParams.set('tradingSection', next);
    if (next !== 'positions') {
      url.searchParams.set('tradingDays', String(readTradingDays(location.search)));
      url.searchParams.set('tradingPair', readTradingPair(location.search));
    }
    history.pushState(null, '', url);
    setSection(next);
  }
  return <div className="trading-center">
    <header className="trading-center-heading"><h1>交易中心</h1><p>全部交易所仓位与原油、海力士、Anthropic 价差套利</p></header>
    <div className="trading-sections" role="tablist" aria-label="交易中心分区">{TRADING_SECTIONS.map(({ id, label }) => {
      const Icon = icons[id];
      return <button key={id} type="button" role="tab" id={`trading-tab-${id}`} aria-selected={section === id} aria-controls="trading-tabpanel" onClick={() => select(id)} {...(id !== 'positions' ? { onMouseEnter: preloadOilPage, onFocus: preloadOilPage } : {})}><Icon size={16} />{label}</button>;
    })}</div>
    <div role="tabpanel" id="trading-tabpanel" aria-labelledby={`trading-tab-${section}`}>
      {section === 'positions' ? <TradingPositions onExpired={onExpired} onProject={onProject} navigationSearch={navigationSearch} /> : null}
      {arbitrageOpened ? <Suspense fallback={section === 'positions' ? null : <div className="positions-empty" role="status"><LoaderCircle className="spin" size={22} /><p>正在加载套利交易…</p></div>}><OilTradingPage cache={cache} onExpired={onExpired} section={section} onSection={select} /></Suspense> : null}
    </div>
  </div>;
}

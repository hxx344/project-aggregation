import { lazy, Suspense, useEffect, useState } from 'react';
import { Gauge, LoaderCircle, Wallet } from 'lucide-react';
import type { TradingCache } from './trading-cache';
import TradingPositions from './TradingPositions';
import './trading-center.css';

const OilTradingPage = lazy(() => import('./OilTradingPage'));
type TradingSection = 'positions' | 'oil';

function readSection(): TradingSection {
  const params = new URLSearchParams(location.search);
  const section = params.get('tradingSection');
  if (section !== null) return section === 'oil' ? 'oil' : 'positions';
  // Existing bookmarks predate the trading center and open the oil strategy.
  return params.has('tradingPair') || params.has('tradingDays') ? 'oil' : 'positions';
}

export default function TradingPage({ cache, onExpired, onProject, navigationSearch }: {
  cache: TradingCache; onExpired: () => void; onProject: (id: string) => void; navigationSearch: string;
}) {
  const [section, setSection] = useState(readSection);
  useEffect(() => { setSection(readSection()); }, [navigationSearch]);
  useEffect(() => {
    const back = () => setSection(readSection());
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  function select(next: TradingSection) {
    if (next === section) return;
    const url = new URL(location.href);
    url.searchParams.set('tradingSection', next);
    if (next === 'oil') {
      url.searchParams.set('tradingDays', String(cache.selection().days));
      url.searchParams.set('tradingPair', cache.selection().pair);
    }
    history.pushState(null, '', url);
    setSection(next);
  }
  return <div className="trading-center">
    <nav className="trading-sections" aria-label="交易模块">
      <button type="button" aria-current={section === 'positions' ? 'page' : undefined} onClick={() => select('positions')}><Wallet size={17} />交易所仓位</button>
      <button type="button" aria-current={section === 'oil' ? 'page' : undefined} onClick={() => select('oil')}><Gauge size={17} />原油四腿套利</button>
    </nav>
    {section === 'positions' ? <TradingPositions onExpired={onExpired} onProject={onProject} navigationSearch={navigationSearch} /> : <Suspense fallback={<div className="positions-empty" role="status"><LoaderCircle className="spin" size={22} /><p>正在加载原油套利…</p></div>}><OilTradingPage cache={cache} onExpired={onExpired} /></Suspense>}
  </div>;
}

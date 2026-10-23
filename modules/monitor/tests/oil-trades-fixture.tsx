import { createRoot } from 'react-dom/client';
import OilPanel from '../app/oil-panel';
import { useHubBridge } from '../lib/hub-bridge';
import '../app/design-tokens.css';
import type { InitialMarketData } from '../lib/initial-market';

const [oilCandles, oilArchive] = await Promise.all(['/oil/data/binance-15m.json', '/oil/data/binance-2026.json'].map(async path => {
  const response = await fetch(path);
  if (!response.ok) throw Error('浏览器测试行情夹具读取失败');
  return response.json();
}));
const initial = { renderedAt: Date.now(), oil: { quote: oilArchive.market, candles: oilCandles }, hynix: { quote: null, history: null }, 'cl-xau': { quote: null, history: null } } as unknown as InitialMarketData;
function Fixture() {
  const hub = useHubBridge('monitor');
  return <OilPanel initial={initial} active={hub.active} summaryActive={false} tradesActive={hub.active}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

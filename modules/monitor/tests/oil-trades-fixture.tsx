import { createRoot } from 'react-dom/client';
import OilPanel from '../app/oil-panel';
import { useHubBridge } from '../lib/hub-bridge';
import '../app/globals.css';
import type { InitialMarketData } from '../lib/initial-market';

const response = await fetch('/oil/data/binance-2026.json');
if (!response.ok) throw Error('浏览器测试行情夹具读取失败');
const oilArchive = await response.json();
// The first render embeds only the overview trend; the panel reads the full candles from the fixture API.
const initial = { renderedAt: Date.now(), oil: { quote: oilArchive.market, trend: null }, hynix: { quote: null, trend: null } } as unknown as InitialMarketData;
function Fixture() {
  const hub = useHubBridge('monitor');
  return <OilPanel initial={initial} active={hub.active} summaryActive={false} tradesActive={hub.active}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

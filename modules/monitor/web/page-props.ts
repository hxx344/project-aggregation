import type { InitialMarketData } from '../lib/initial-market';

export type PageProps = {
  initial: InitialMarketData | null;
  initialMonitor: 'oil' | 'hynix' | 'perpetual' | 'cl-xau';
  initialGoldOil: 'cl' | 'bz';
  initialGoldOilExchange: 'binance' | 'bybit';
};

export function pageProps(url: URL, initial: InitialMarketData | null): PageProps {
  const monitor = url.searchParams.get('monitor');
  return {
    initial,
    initialMonitor: monitor === 'hynix' || monitor === 'perpetual' || monitor === 'cl-xau' ? monitor : 'oil',
    initialGoldOil: url.searchParams.get('goldOil') === 'bz' ? 'bz' : 'cl',
    initialGoldOilExchange: url.searchParams.get('goldOilExchange') === 'bybit' ? 'bybit' : 'binance',
  };
}

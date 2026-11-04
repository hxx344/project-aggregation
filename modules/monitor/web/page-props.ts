import type { InitialMarketData } from '../lib/initial-market';

export type PageProps = {
  initial: InitialMarketData | null;
  initialMonitor: 'oil' | 'hynix' | 'perpetual';
};

export function pageProps(url: URL, initial: InitialMarketData | null): PageProps {
  const monitor = url.searchParams.get('monitor');
  return {
    initial,
    // Retired ids (such as the removed gold/oil `cl-xau`) fall back to the oil monitor.
    initialMonitor: monitor === 'hynix' || monitor === 'perpetual' ? monitor : 'oil',
  };
}

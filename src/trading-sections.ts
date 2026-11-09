// Trading center tabs, addressed as ?view=trading&tradingSection=….
export type TradingSection = 'positions' | 'trade' | 'pnl' | 'auto' | 'accounts';
export const TRADING_SECTIONS: { id: TradingSection; label: string }[] = [
  { id: 'positions', label: '全部仓位' },
  { id: 'trade', label: '价差下单' },
  { id: 'pnl', label: '盈亏资金费' },
  { id: 'auto', label: '自动规则' },
  { id: 'accounts', label: '账户连接' },
];

export function tradingSectionOf(search: string, fallback: TradingSection = 'positions'): TradingSection {
  const params = new URLSearchParams(search);
  const section = params.get('tradingSection');
  if (TRADING_SECTIONS.some(item => item.id === section)) return section as TradingSection;
  // `oil` was the single arbitrage page and `legs` the separate 套利仓位 tab (now the right column of 价差下单);
  // links without a section predate the trading center.
  if (section === 'oil' || section === 'legs' || section === null && (params.has('tradingPair') || params.has('tradingDays'))) return 'trade';
  return section === null ? fallback : 'positions';
}

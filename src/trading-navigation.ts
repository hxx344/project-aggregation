import { TRADING_SECTIONS, tradingSectionOf } from './trading-sections';
import type { TradingSection } from './trading-sections';
import { readPreference, writePreference } from './ui-preferences';

const key = 'workbench:trading-section:v1';
export function readTradingSection(search: string): TradingSection {
  const saved = readPreference(key);
  // A saved `legs` predates the merge of 套利仓位 into 价差下单.
  const fallback = saved === 'legs' ? 'trade' : TRADING_SECTIONS.some(section => section.id === saved) ? saved as TradingSection : 'positions';
  return tradingSectionOf(search, fallback);
}
export const saveTradingSection = (section: TradingSection) => writePreference(key, section);

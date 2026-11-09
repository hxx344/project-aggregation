import { TRADING_SECTIONS, tradingSectionOf } from './trading-sections';
import type { TradingSection } from './trading-sections';
import { readPreference, writePreference } from './ui-preferences';

const key = 'workbench:trading-section:v1';
export function readTradingSection(search: string): TradingSection {
  const saved = readPreference(key);
  return tradingSectionOf(search, TRADING_SECTIONS.some(section => section.id === saved) ? saved as TradingSection : 'positions');
}
export const saveTradingSection = (section: TradingSection) => writePreference(key, section);

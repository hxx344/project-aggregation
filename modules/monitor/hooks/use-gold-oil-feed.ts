"use client";

import { useEffect, useRef, useState } from 'react';
import { GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_FUNDING_MS, goldOilAction, goldOilVariantKey, GOLD_OIL_VARIANTS, validateGoldOilQuote, validateGoldOilHistory, type GoldOilType, type GoldOilExchange, type GoldOilQuote, type GoldOilHistory } from '../lib/gold-oil';
import { validateGoldOilFunding, type GoldOilFundingHistory } from '../lib/gold-oil-funding';
import { initialGoldOilMarket, type InitialMarketData } from '../lib/initial-market';
import { startActivityPolling } from '../lib/polling';

async function request(action: string, oilType: GoldOilType, exchange: GoldOilExchange, signal: AbortSignal) {
  const response = await fetch(`/api/monitors/cl-xau/${goldOilAction(action, oilType, exchange)}`, { cache: 'no-store', signal });
  if (!response.ok) throw Error('金油比行情更新失败');
  return response.json() as Promise<unknown>;
}
type MarketCache = {
  quote: GoldOilQuote | null; history: GoldOilHistory | null; funding: GoldOilFundingHistory | null;
  quoteError: boolean; historyError: boolean; fundingError: boolean;
  quoteReadAt: number; historyReadAt: number; fundingReadAt: number;
};
function initialCache(initial: InitialMarketData | null | undefined, oilType: GoldOilType, exchange: GoldOilExchange): MarketCache {
  const seed = initialGoldOilMarket(initial, oilType, exchange);
  const normalize = <T,>(value: unknown, validate: (value: unknown, oilType: GoldOilType, exchange: GoldOilExchange) => T): T | null => {
    if (!value) return null;
    try { return validate(value, oilType, exchange); } catch { return null; }
  };
  const quote = normalize(seed?.quote, validateGoldOilQuote), history = normalize(seed?.history, validateGoldOilHistory), funding = normalize(seed?.funding, validateGoldOilFunding);
  const readAt = initial?.renderedAt ?? 0;
  return { quote, history, funding, quoteError: false, historyError: false, fundingError: false,
    quoteReadAt: quote ? readAt : 0, historyReadAt: history ? readAt : 0, fundingReadAt: funding ? readAt : 0 };
}
export function useGoldOilFeed(initial: InitialMarketData | null | undefined, active: boolean, summaryActive: boolean, oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance') {
  const [markets, setMarkets] = useState<Record<string, MarketCache>>(() => Object.fromEntries(GOLD_OIL_VARIANTS.map(({ oilType, exchange }) => [goldOilVariantKey(oilType, exchange), initialCache(initial, oilType, exchange)])));
  const key = goldOilVariantKey(oilType, exchange);
  const cache = useRef(markets);
  const polls = useRef<Record<string, ReturnType<typeof startActivityPolling>>>({});
  useEffect(() => {
    if (!summaryActive) return;
    const controls = polls.current, current = cache.current[key];
    const poll = startActivityPolling({ intervalMs: GOLD_OIL_QUOTE_MS,
      immediate: !current.quote || current.quoteError || Date.now() - current.quoteReadAt >= GOLD_OIL_QUOTE_MS,
      load: async signal => validateGoldOilQuote(await request('quote', oilType, exchange, signal), oilType, exchange),
      onData: value => { cache.current = { ...cache.current, [key]: { ...cache.current[key], quote: value, quoteError: false, quoteReadAt: Date.now() } }; setMarkets(cache.current); },
      onError: () => { cache.current = { ...cache.current, [key]: { ...cache.current[key], quoteError: true } }; setMarkets(cache.current); } });
    controls.quote = poll;
    return () => { delete controls.quote; poll.stop(); };
  }, [summaryActive, oilType, exchange, key]);
  useEffect(() => {
    if (!active) return;
    const controls = polls.current, current = cache.current[key];
    const history = startActivityPolling({ intervalMs: GOLD_OIL_HISTORY_MS, timeoutMs: 60_000,
      immediate: !current.history || current.historyError || Date.now() - current.historyReadAt >= GOLD_OIL_HISTORY_MS,
      load: async signal => validateGoldOilHistory(await request('history', oilType, exchange, signal), oilType, exchange),
      onData: value => { cache.current = { ...cache.current, [key]: { ...cache.current[key], history: value, historyError: false, historyReadAt: Date.now() } }; setMarkets(cache.current); },
      onError: () => { cache.current = { ...cache.current, [key]: { ...cache.current[key], historyError: true } }; setMarkets(cache.current); } });
    const funding = startActivityPolling({ intervalMs: GOLD_OIL_FUNDING_MS, timeoutMs: 60_000,
      immediate: !current.funding || current.fundingError || Date.now() - current.fundingReadAt >= GOLD_OIL_FUNDING_MS,
      load: async signal => validateGoldOilFunding(await request('funding', oilType, exchange, signal), oilType, exchange),
      onData: value => { cache.current = { ...cache.current, [key]: { ...cache.current[key], funding: value, fundingError: false, fundingReadAt: Date.now() } }; setMarkets(cache.current); },
      onError: () => { cache.current = { ...cache.current, [key]: { ...cache.current[key], fundingError: true } }; setMarkets(cache.current); } });
    controls.history = history; controls.funding = funding;
    return () => { delete controls.history; delete controls.funding; history.stop(); funding.stop(); };
  }, [active, oilType, exchange, key]);
  // Select during render; an effect-driven reset can briefly expose another exchange/oil combination's data.
  return { ...markets[key], refresh: () => { for (const poll of Object.values(polls.current)) void poll.refresh(); } };
}

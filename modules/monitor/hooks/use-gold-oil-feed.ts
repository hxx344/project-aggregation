"use client";

import { useEffect, useRef, useState } from 'react';
import { GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, goldOilAction, goldOilVariantKey, GOLD_OIL_VARIANTS, validateGoldOilQuote, type GoldOilType, type GoldOilExchange, type GoldOilQuote } from '../lib/gold-oil';
import { validateGoldOilChartData, type GoldOilChartData, type GoldOilChartRange } from '../lib/gold-oil-chart-data';
import { mergeGoldOilChartData, goldOilChartOverviewTrend } from '../lib/gold-oil-chart-feed';
import { initialGoldOilMarket, type InitialMarketData } from '../lib/initial-market';
import type { MonitorTrend } from '../lib/monitor-trend';
import { startActivityPolling } from '../lib/polling';
import { backgroundReadDelay } from '../lib/read-activity';

async function request(action: string, oilType: GoldOilType, exchange: GoldOilExchange, signal: AbortSignal, range?: GoldOilChartRange) {
  const path = '/api/monitors/cl-xau/' + goldOilAction(action, oilType, exchange) + (range ? '?range=' + range : '');
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw Error('金油比行情更新失败');
  return response.json() as Promise<unknown>;
}
type MarketCache = { quote: GoldOilQuote | null; quoteError: boolean; quoteReadAt: number; trend?: MonitorTrend };
type ChartCache = { data: GoldOilChartData | null; error: boolean; readAt: number };
function initialCache(initial: InitialMarketData | null | undefined, oilType: GoldOilType, exchange: GoldOilExchange): MarketCache {
  const seed = initialGoldOilMarket(initial, oilType, exchange);
  let quote: GoldOilQuote | null = null;
  try { if (seed?.quote) quote = validateGoldOilQuote(seed.quote, oilType, exchange); } catch { /* Invalid seeds are fetched again. */ }
  return { quote, quoteError: false, quoteReadAt: quote ? initial?.renderedAt ?? 0 : 0, trend: seed?.trend };
}

export function useGoldOilFeed(initial: InitialMarketData | null | undefined, active: boolean, summaryActive: boolean, oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance', range: GoldOilChartRange = '7d') {
  const [markets, setMarkets] = useState<Record<string, MarketCache>>(() => Object.fromEntries(GOLD_OIL_VARIANTS.map(({ oilType, exchange }) => [goldOilVariantKey(oilType, exchange), initialCache(initial, oilType, exchange)])));
  // Range payloads never enter the complete-history cache or another selection.
  // Four variants times four supported ranges keep this per-panel cache bounded.
  const [charts, setCharts] = useState<Record<string, ChartCache>>({});
  const key = goldOilVariantKey(oilType, exchange), chartKey = key + '/' + range;
  const cache = useRef(markets), chartCache = useRef(charts);
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
    const controls = polls.current, current = chartCache.current[chartKey], retryUntil = Date.now() + 60_000;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const clearRetry = () => { clearTimeout(retry); retry = undefined; };
    const poll = startActivityPolling({ intervalMs: GOLD_OIL_HISTORY_MS, timeoutMs: 60_000,
      immediate: !current?.data || current.error || !current.data.history || !current.data.funding || Date.now() - current.readAt >= GOLD_OIL_HISTORY_MS,
      load: async signal => validateGoldOilChartData(await request('chart', oilType, exchange, signal, range), range, oilType, exchange),
      onData: value => {
        clearRetry();
        const previous = chartCache.current[chartKey]?.data, data = mergeGoldOilChartData(previous, value);
        chartCache.current = { ...chartCache.current, [chartKey]: { data, error: false, readAt: Date.now() } }; setCharts(chartCache.current);
        const trend = goldOilChartOverviewTrend(data, cache.current[key].trend);
        if (trend !== cache.current[key].trend) { cache.current = { ...cache.current, [key]: { ...cache.current[key], trend } }; setMarkets(cache.current); }
        // Quickly discover datasets committed just after startup. Persistent
        // upstream failures return to the normal cadence after one minute.
        if (Date.now() < retryUntil && ((!value.history && !previous?.history) || (!value.funding && !previous?.funding))) {
          retry = setTimeout(() => { retry = undefined; void poll.refresh(); }, backgroundReadDelay(3000));
        }
      },
      onError: () => {
        clearRetry();
        const old = chartCache.current[chartKey];
        chartCache.current = { ...chartCache.current, [chartKey]: { data: old?.data ?? null, error: true, readAt: old?.readAt ?? 0 } };
        setCharts(chartCache.current);
        const trend = cache.current[key].trend;
        if (trend && range !== '1d') { cache.current = { ...cache.current, [key]: { ...cache.current[key], trend: { ...trend, status: 'stale' } } }; setMarkets(cache.current); }
      },
    });
    controls.chart = poll;
    return () => { clearRetry(); delete controls.chart; poll.stop(); };
  }, [active, oilType, exchange, range, key, chartKey]);
  const selected = charts[chartKey], chart = selected?.data ?? null;
  return { ...markets[key], chart, chartError: selected?.error ?? false,
    history: chart?.history ?? null, funding: chart?.funding ?? null,
    historyError: Boolean(selected?.error || chart?.historyError), fundingError: Boolean(selected?.error || chart?.fundingError),
    refresh: () => { for (const poll of Object.values(polls.current)) void poll.refresh(); } };
}

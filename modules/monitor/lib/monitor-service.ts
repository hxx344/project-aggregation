import { getMonitor } from "./monitors.ts";
import { loadQuote } from "./quote-service.ts";
import { loadMarket } from "./market-service.ts";
import { loadHynixFunding } from "./hynix-funding-service.ts";
import { loadOilMarket, loadOilDaily, loadOilFunding } from './oil-market-service.ts';
import { exchangeFromAction, supportsExchange, type SpreadMarket } from "./exchange-quotes.ts";
import { readExchangeQuote } from "./exchange-service.ts";
import { loadOilIntraday } from "./oil-intraday-service.ts";
import { OIL_CANDLE_ACTION } from "../modules/oil/intraday.mjs";
import { loadPerpetualSnapshot } from './perpetual-service.ts';
import { goldOilReader, goldOilBzReader, goldOilBybitReader, goldOilBybitBzReader } from './gold-oil-service.ts';
import { GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_FUNDING_MS, parseGoldOilAction } from './gold-oil.ts';
import { fundingExchangeFromAction, HISTORY_REFRESH_MS, type ExchangeFundingHistory } from './exchange-funding-history.ts';
import { readExchangeFundingHistory } from './exchange-funding-service.ts';
import { OIL_HEDGE_PRICES_ACTION, HEDGE_PRICES_REFRESH_MS, type OilHedgePrices } from './oil-hedge-prices.ts';
import { readOilHedgePrices } from './oil-hedge-price-service.ts';

export interface DataAdapter {
  quote: () => Promise<unknown>;
  history?: () => Promise<unknown>;
  funding?: () => Promise<unknown>;
  'bz/quote'?: () => Promise<unknown>;
  'bz/history'?: () => Promise<unknown>;
  'bz/funding'?: () => Promise<unknown>;
  'bybit/quote'?: () => Promise<unknown>;
  'bybit/history'?: () => Promise<unknown>;
  'bybit/funding'?: () => Promise<unknown>;
  'bybit/bz/quote'?: () => Promise<unknown>;
  'bybit/bz/history'?: () => Promise<unknown>;
  'bybit/bz/funding'?: () => Promise<unknown>;
  "candles/15m"?: () => Promise<unknown>;
}
/** Add a data adapter here and a descriptor in monitors.ts to expose a new module. */
export const dataAdapters: Record<string, DataAdapter> = {
  'cl-xau': { ...goldOilReader, 'bz/quote': goldOilBzReader.quote, 'bz/history': goldOilBzReader.history, 'bz/funding': goldOilBzReader.funding, 'bybit/quote': goldOilBybitReader.quote, 'bybit/history': goldOilBybitReader.history, 'bybit/funding': goldOilBybitReader.funding, 'bybit/bz/quote': goldOilBybitBzReader.quote, 'bybit/bz/history': goldOilBybitBzReader.history, 'bybit/bz/funding': goldOilBybitBzReader.funding },
  perpetual: { quote: loadPerpetualSnapshot },
  hynix: { quote: loadQuote, history: loadMarket, funding: loadHynixFunding },
  oil: {
    [OIL_CANDLE_ACTION]: loadOilIntraday,
    quote: loadOilMarket,
    history: loadOilDaily,
    funding: loadOilFunding,
  },
};

export function createDataReader(adapters = dataAdapters, clock = Date.now, exchangeReader = readExchangeQuote, fundingReader = readExchangeFundingHistory, pricesReader = readOilHedgePrices) {
  const cache = new Map<string, { value: unknown; until: number }>();
  const pending = new Map<string, Promise<unknown>>();
  return async function read(id: string, action: string) {
    const exchange = exchangeFromAction(action);
    const fundingExchange = fundingExchangeFromAction(action);
    const hedgePrices = action === OIL_HEDGE_PRICES_ACTION;
    const goldOil = id === 'cl-xau' ? parseGoldOilAction(action) : null;
    const goldOilData = goldOil && ['quote', 'history', 'funding'].includes(goldOil.action);
    if (hedgePrices && id !== 'oil') throw new Error('Unsupported monitor capability');
    if (fundingExchange && id !== 'oil') throw new Error('Unsupported monitor capability');
    if (exchange && !supportsExchange(id, exchange)) throw new Error('Unsupported monitor capability');
    if (id === 'cl-xau' && !goldOilData) throw new Error('Unknown monitor action');
    if (!getMonitor(id) || !Object.hasOwn(adapters, id) || (!["quote", "history", "funding", OIL_CANDLE_ACTION].includes(action) && !goldOilData && !exchange && !fundingExchange && !hedgePrices)) throw new Error("Unknown monitor action");
    const key = `${id}/${action}`, previous = cache.get(key);
    const loader = hedgePrices ? () => pricesReader(previous?.value as OilHedgePrices | undefined) : fundingExchange ? () => fundingReader(fundingExchange, previous?.value as ExchangeFundingHistory | undefined) : exchange ? () => exchangeReader(exchange, id as SpreadMarket) : adapters[id][action as keyof DataAdapter];
    if (!loader) throw new Error("Unsupported monitor capability");
    if (previous && clock() < previous.until) return previous.value;
    if (!pending.has(key)) {
      const request = Promise.resolve().then(loader).then(value => {
        const snapshot = (value as { status?: string })?.status === "snapshot";
        const ttl = hedgePrices ? snapshot ? 15_000 : HEDGE_PRICES_REFRESH_MS : fundingExchange ? HISTORY_REFRESH_MS : snapshot ? 15_000 : goldOil ? goldOil.action === 'quote' ? GOLD_OIL_QUOTE_MS : goldOil.action === 'history' ? GOLD_OIL_HISTORY_MS : GOLD_OIL_FUNDING_MS : action === "quote" || exchange ? 5_000 : action === "history" || action === OIL_CANDLE_ACTION ? 60_000 : 300_000;
        cache.set(key, { value, until: clock() + ttl });
        return value;
      }).catch(error => {
        if ((!fundingExchange && !hedgePrices) || !previous) throw error;
        const value = hedgePrices ? { ...previous.value as OilHedgePrices, status: 'snapshot' as const } : { ...previous.value as ExchangeFundingHistory, status: 'snapshot' as const, reason: '历史结算费率暂时更新失败，保留上次成功记录。' };
        cache.set(key, { value, until: clock() + 15_000 });
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
    }
    // Failed live quotes reject. Old values are never timestamped as fresh.
    return pending.get(key)!;
  };
}
export const readMonitorData = createDataReader();

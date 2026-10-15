import { comparisonExchanges, exchangeAction } from '../lib/exchange-quotes.ts';
import { goldOilAction } from '../lib/gold-oil.ts';
import { goldOilTrend } from '../lib/monitor-summary.ts';

/** Read the same persisted snapshots as the APIs; never start upstream requests. */
export async function readInitialMarket(services) {
  const read = async (id, action) => {
    try { return await services.get(id).handle(action, "GET"); }
    catch { return null; }
  };
  const exchanges = async id => Object.fromEntries(await Promise.all(comparisonExchanges(id).map(async exchange => [exchange, await read(id, exchangeAction(exchange))])));
  const goldOil = async (oilType, exchange) => {
    const [quote, history] = await Promise.all(['quote', 'history'].map(action => read('cl-xau', goldOilAction(action, oilType, exchange))));
    // Overview trends are bounded; complete history and funding stay behind
    // the existing detail APIs and are fetched when that market is opened.
    return { quote, history: null, funding: null, ...(history ? { trend: goldOilTrend(history, false, oilType, exchange) } : {}) };
  };
  const [hynixQuote, hynixHistory, oilQuote, hynixExchanges, oilExchanges, oilCandles, goldOilCl, goldOilBz, bybitCl, bybitBz] = await Promise.all([
    read("hynix", "quote"), read("hynix", "history"), read("oil", "quote"),
    exchanges('hynix'), exchanges('oil'),
    read("oil", "candles/15m"),
    goldOil('cl', 'binance'), goldOil('bz', 'binance'), goldOil('cl', 'bybit'), goldOil('bz', 'bybit'),
  ]);
  return { renderedAt: Date.now(), ...(services.controls ? { runtime: services.controls.view() } : {}), 'cl-xau': { ...goldOilCl, bz: goldOilBz, bybit: { ...bybitCl, bz: bybitBz } }, hynix: { quote: hynixQuote, history: hynixHistory, exchanges: hynixExchanges }, oil: { quote: oilQuote, candles: oilCandles, exchanges: oilExchanges } };
}

export function registerInitialMarket(services) {
  const key = Symbol.for("market-monitor.initial-data");
  const provider = () => readInitialMarket(services);
  if (globalThis[key]) throw new Error("Initial market provider already registered");
  globalThis[key] = provider;
  return () => { if (globalThis[key] === provider) delete globalThis[key]; };
}

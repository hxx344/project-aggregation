import { comparisonExchanges, exchangeAction } from '../lib/exchange-quotes.ts';

/** Read the same persisted snapshots as the APIs; never start upstream requests. */
export async function readInitialMarket(services) {
  const read = async (id, action) => {
    try { return await services.get(id).handle(action, "GET"); }
    catch { return null; }
  };
  const exchanges = async id => Object.fromEntries(await Promise.all(comparisonExchanges(id).map(async exchange => [exchange, await read(id, exchangeAction(exchange))])));
  const goldOil = async prefix => Object.fromEntries(await Promise.all(['quote', 'history', 'funding'].map(async action => [action, await read('cl-xau', prefix + action)])));
  const [hynixQuote, hynixHistory, oilQuote, hynixExchanges, oilExchanges, oilCandles, goldOilCl, goldOilBz, bybitCl, bybitBz] = await Promise.all([
    read("hynix", "quote"), read("hynix", "history"), read("oil", "quote"),
    exchanges('hynix'), exchanges('oil'),
    read("oil", "candles/15m"),
    goldOil(''), goldOil('bz/'), goldOil('bybit/'), goldOil('bybit/bz/'),
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

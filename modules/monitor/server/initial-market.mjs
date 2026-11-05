import { comparisonExchanges, exchangeAction } from '../lib/exchange-quotes.ts';
import { createTrend } from '../lib/monitor-trend.ts';
import { hynixTrendOptions } from '../lib/monitor-summary.ts';

/** The overview card's seven-day window, with the source status and time kept intact. */
function hynixTrend(history) {
  if (!Array.isArray(history?.points)) return null;
  const source = { points: history.points.map(point => ({ time: point.time, value: point.premium })), status: history.status, fetchedAt: history.fetchedAt };
  return { points: createTrend(source, hynixTrendOptions).points, status: source.status, fetchedAt: source.fetchedAt };
}

/** Read the same persisted snapshots as the APIs; never start upstream requests. */
export async function readInitialMarket(services) {
  const read = async (id, action) => {
    try { return await services.get(id).handle(action, "GET"); }
    catch { return null; }
  };
  const exchanges = async id => Object.fromEntries(await Promise.all(comparisonExchanges(id).map(async exchange => [exchange, await read(id, exchangeAction(exchange))])));
  const [hynixQuote, hynixHistory, oilQuote, hynixExchanges, oilExchanges, oilCandles] = await Promise.all([
    read("hynix", "quote"), read("hynix", "history"), read("oil", "quote"),
    exchanges('hynix'), exchanges('oil'),
    read("oil", "candles/15m"),
  ]);
  return { renderedAt: Date.now(), ...(services.controls ? { runtime: services.controls.view() } : {}), hynix: { quote: hynixQuote, trend: hynixTrend(hynixHistory), exchanges: hynixExchanges }, oil: { quote: oilQuote, candles: oilCandles, exchanges: oilExchanges } };
}

export function registerInitialMarket(services) {
  const key = Symbol.for("market-monitor.initial-data");
  const provider = () => readInitialMarket(services);
  if (globalThis[key]) throw new Error("Initial market provider already registered");
  globalThis[key] = provider;
  return () => { if (globalThis[key] === provider) delete globalThis[key]; };
}

import { exchangeContracts, validateExchangeQuote, oilExchangeQuote, validateComparisonQuote, supportsExchange, type Exchange, type ExchangeLeg, type ExchangeQuote, type ExternalExchange, type SpreadMarket } from "./exchange-quotes.ts";
import { fetchMarket as fetchHyperliquidOil } from '../modules/oil/hyperliquid.mjs';
import { createOilCexReader } from './oil-cex.ts';
import { createOilDexReader } from './oil-dex.ts';
import type { VariationalSession } from './variational-api.ts';

type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid exchange response"); return value as JsonObject; };
const list = (value: unknown): JsonObject[] => { if (!Array.isArray(value)) throw new Error("Invalid exchange list"); return value.map(obj); };
const finite = (value: unknown) => { if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "" || !Number.isFinite(Number(value))) throw new Error("Invalid exchange number"); return Number(value); };
const positive = (value: unknown) => { const result = finite(value); if (result <= 0) throw new Error("Invalid exchange price"); return result; };
const optionalNumber = (value: unknown) => { try { return finite(value); } catch { return null; } };
const interval = (value: unknown) => { const hours = optionalNumber(value); return hours !== null && Number.isInteger(hours) && hours > 0 && hours <= 24 ? hours : null; };
function unique(items: JsonObject[], symbol: string) { const matches = items.filter(item => item.symbol === symbol); if (matches.length !== 1) throw new Error(`Missing or duplicate contract ${symbol}`); return matches[0]; }
function time(value: unknown, now: number) { const result = finite(value); if (!Number.isSafeInteger(result) || result < now - 120_000 || result > now + 60_000) throw new Error("Delayed or invalid exchange quote"); return result; }
function bybit(response: unknown) { const value = obj(response); if (value.retCode !== 0) throw new Error("Bybit market response failed"); const result = obj(value.result); if (result.category !== "linear") throw new Error("Unexpected Bybit contract category"); return { value, result, items: list(result.list) }; }

export function parseBybitQuote(monitorId: SpreadMarket, instruments: JsonObject[], response: unknown, now = Date.now()): ExchangeQuote {
  const { value, items } = bybit(response), fetchedAt = new Date(time(value.time, now)).toISOString();
  const contracts = exchangeContracts[monitorId];
  const leg = (symbol: string, base: string): ExchangeLeg => {
    const metadata = unique(instruments, symbol), ticker = unique(items, symbol);
    if (metadata.status !== "Trading" || metadata.contractType !== "LinearPerpetual" || metadata.baseCoin !== base || metadata.quoteCoin !== "USDT" || metadata.settleCoin !== "USDT" || metadata.isPreListing === true) throw new Error("Unsupported Bybit contract");
    const price = positive(ticker.markPrice);
    const fundingIntervalHours = ticker.fundingIntervalHour === undefined ? interval(optionalNumber(metadata.fundingInterval) === null ? null : finite(metadata.fundingInterval) / 60) : interval(ticker.fundingIntervalHour);
    const fundingRate = optionalNumber(ticker.fundingRate), next = optionalNumber(ticker.nextFundingTime);
    return { symbol, price, fundingPrice: price, fundingRate: fundingRate !== null && Math.abs(fundingRate) <= 1 ? fundingRate : null, fundingIntervalHours, nextFundingAt: next !== null && next >= Date.parse(fetchedAt) - 60_000 && next <= now + 25 * 3_600_000 ? new Date(next).toISOString() : null };
  };
  return finish("bybit", monitorId, fetchedAt, leg(contracts.left, contracts.leftBase), leg(contracts.right, contracts.rightBase));
}

export function parseBinanceQuote(monitorId: SpreadMarket, instruments: unknown, response: unknown, fundingInfo: unknown, now = Date.now()): ExchangeQuote {
  const contracts = exchangeContracts[monitorId], metadata = list(obj(instruments).symbols), tickers = list(response);
  const funding = fundingInfo === null ? [] : list(fundingInfo);
  const sourceTimes: number[] = [];
  const leg = (symbol: string, base: string): ExchangeLeg => {
    const spec = unique(metadata, symbol), ticker = unique(tickers, symbol);
    if (spec.status !== "TRADING" || !["PERPETUAL", "TRADIFI_PERPETUAL"].includes(String(spec.contractType)) || spec.baseAsset !== base || spec.quoteAsset !== "USDT" || spec.marginAsset !== "USDT") throw new Error("Unsupported Binance contract");
    sourceTimes.push(time(ticker.time, now));
    const price = positive(ticker.markPrice), fundingSpecs = funding.filter(item => item.symbol === symbol);
    if (fundingSpecs.length > 1) throw new Error("Duplicate funding metadata");
    const fundingIntervalHours = interval(fundingSpecs[0]?.fundingIntervalHours), fundingRate = optionalNumber(ticker.lastFundingRate), next = optionalNumber(ticker.nextFundingTime);
    return { symbol, price, fundingPrice: price, fundingRate: fundingRate !== null && Math.abs(fundingRate) <= 1 ? fundingRate : null, fundingIntervalHours, nextFundingAt: next !== null && next >= finite(ticker.time) - 60_000 && next <= now + 25 * 3_600_000 ? new Date(next).toISOString() : null };
  };
  const left = leg(contracts.left, contracts.leftBase), right = leg(contracts.right, contracts.rightBase);
  if (Math.abs(sourceTimes[0] - sourceTimes[1]) > 15_000) throw new Error("Exchange quote legs are not synchronized");
  return finish("binance", monitorId, new Date(Math.min(...sourceTimes)).toISOString(), left, right);
}

function finish(exchange: ExternalExchange, monitorId: SpreadMarket, fetchedAt: string, left: ExchangeLeg, right: ExchangeLeg) {
  const complete = [left, right].every(leg => leg.fundingRate !== null && leg.fundingIntervalHours !== null && leg.nextFundingAt !== null);
  // Missing current settlement metadata must not fabricate a funding estimate.
  if (!complete) { left = { ...left, fundingRate: null }; right = { ...right, fundingRate: null }; }
  return validateExchangeQuote({ exchange, monitorId, currency: "USDT", priceBasis: "mark", fundingPriceBasis: "mark", fetchedAt, fundingFetchedAt: complete ? fetchedAt : null, status: "live", left, right, fundingError: complete ? "" : "资金费或结算周期暂不可用，价格仍正常更新。" }, exchange, monitorId);
}

/** Share only transport requests; one unavailable pair cannot stop the other market. */
export function createExchangeReader({ fetcher = fetch, clock = Date.now, variationalSession, variationalFetcher = fetcher }: { fetcher?: typeof fetch; clock?: () => number; variationalSession?: VariationalSession; variationalFetcher?: typeof fetch } = {}) {
  const cache = new Map<string, { value: unknown; until: number }>(), pending = new Map<string, Promise<unknown>>();
  async function request(url: string) {
    const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Exchange market HTTP ${response.status}`);
    return response.json();
  }
  function shared(key: string, ttl: number, load: () => Promise<unknown>) {
    const previous = cache.get(key);
    if (previous && clock() < previous.until) return Promise.resolve(previous.value);
    let operation = pending.get(key);
    if (!operation) { operation = Promise.resolve().then(load).then(value => { cache.set(key, { value, until: clock() + ttl }); return value; }).finally(() => pending.delete(key)); pending.set(key, operation); }
    return operation;
  }
  async function bybitInstruments() {
    const items: JsonObject[] = [], cursors = new Set<string>();
    let cursor = "";
    do {
      const url = new URL("https://api.bybit.com/v5/market/instruments-info");
      url.search = new URLSearchParams({ category: "linear", limit: "1000", ...(cursor ? { cursor } : {}) }).toString();
      const result = bybit(await request(url.href)); items.push(...result.items);
      cursor = String(result.result.nextPageCursor ?? "");
      if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error("Bybit instrument pagination did not advance");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return items;
  }
  const readOilCex = createOilCexReader({ request, shared, clock });
  const readOilDex = createOilDexReader({ request, shared, clock, fetcher: variationalFetcher, variationalSession });
  return async (exchange: Exchange, monitorId: SpreadMarket): Promise<ExchangeQuote> => {
    if (!Object.hasOwn(exchangeContracts, monitorId)) throw new Error("Unknown spread market");
    if (!supportsExchange(monitorId, exchange)) throw new Error('Unsupported exchange comparison market');
    if (exchange === 'okx' || exchange === 'bitget') return readOilCex(exchange);
    if (exchange === 'lighter' || exchange === 'variational') return readOilDex(exchange);
    if (exchange === 'hyperliquid') {
      if (monitorId !== 'oil') throw new Error('Unsupported Hyperliquid comparison market');
      return validateComparisonQuote(await shared('hyperliquid/oil', 1000, async () => oilExchangeQuote(await fetchHyperliquidOil({ fetcher }))), exchange, monitorId);
    }
    if (exchange === "bybit") {
      const [metadata, tickers] = await Promise.all([shared("bybit/instruments", 60_000, bybitInstruments), shared("bybit/tickers", 1000, () => request("https://api.bybit.com/v5/market/tickers?category=linear"))]);
      return parseBybitQuote(monitorId, metadata as JsonObject[], tickers, clock());
    }
    if (exchange === "binance") {
      const [metadata, tickers, funding] = await Promise.all([shared("binance/instruments", 60_000, () => request("https://fapi.binance.com/fapi/v1/exchangeInfo")), shared("binance/tickers", 1000, () => request("https://fapi.binance.com/fapi/v1/premiumIndex")), shared("binance/funding", 15_000, async () => list(await request("https://fapi.binance.com/fapi/v1/fundingInfo"))).catch(() => null)]);
      return parseBinanceQuote(monitorId, metadata, tickers, funding, clock());
    }
    throw new Error("Unknown exchange");
  };
}

export const readExchangeQuote = createExchangeReader();

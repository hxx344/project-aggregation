import type { LiveQuote } from "./market";
import { oilSpreadPercent } from '../modules/oil/spread.mjs';
import { validateMarket } from '../modules/oil/binance.mjs';

export const externalExchanges = ["bybit", "binance", "lighter", "variational", "okx", "bitget"] as const;
export type ExternalExchange = typeof externalExchanges[number];
export type Exchange = "hyperliquid" | ExternalExchange;
export type SpreadMarket = "oil" | "hynix";
const oilExchanges: readonly Exchange[] = ['hyperliquid', ...externalExchanges];
const hynixExchanges: readonly Exchange[] = ['bybit', 'binance'];
const hynixDisplayExchanges: readonly Exchange[] = ['hyperliquid', ...hynixExchanges];
export const comparisonExchanges = (market: SpreadMarket): readonly Exchange[] => market === 'oil' ? oilExchanges : hynixExchanges;
export const displayComparisonExchanges = (market: SpreadMarket): readonly Exchange[] => market === 'oil' ? oilExchanges : hynixDisplayExchanges;
export const supportsExchange = (market: string, exchange: Exchange) => (market === 'oil' || market === 'hynix') && comparisonExchanges(market).includes(exchange);
export const EXCHANGE_REFRESH_MS = 15_000;
export const EXCHANGE_STALE_MS = 45_000;
export const exchangeNames: Record<Exchange, string> = { hyperliquid: "Hyperliquid", bybit: "Bybit", binance: "Binance", lighter: "Lighter", variational: "Variational", okx: "OKX", bitget: "Bitget" };
export const exchangeContracts = {
  oil: { left: "BZUSDT", right: "CLUSDT", leftBase: "BZ", rightBase: "CL", leftLabel: "布伦特", rightLabel: "WTI", leftUnits: 1 },
  hynix: { left: "SKHYUSDT", right: "SKHYNIXUSDT", leftBase: "SKHY", rightBase: "SKHYNIX", leftLabel: "ADR", rightLabel: "正股", leftUnits: 10 },
} as const;
type ExchangeDefinition = { left: string; right: string; currency: "USD" | "USDT" | "USDC"; priceBasis: "mid" | "mark"; fundingPriceBasis: "oracle" | "index" | "mark" };
const oilDefinitions: Record<Exchange, ExchangeDefinition> = {
  hyperliquid: { left: 'xyz:BRENTOIL', right: 'xyz:CL', currency: 'USD', priceBasis: 'mark', fundingPriceBasis: 'oracle' },
  bybit: { left: 'BZUSDT', right: 'CLUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
  binance: { left: 'BZUSDT', right: 'CLUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
  lighter: { left: 'BRENTOIL', right: 'WTI', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'index' },
  variational: { left: 'BZ', right: 'CL', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'mark' },
  okx: { left: 'BZ-USDT-SWAP', right: 'CL-USDT-SWAP', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
  bitget: { left: 'BZUSDT', right: 'CLUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
};
export function exchangeDefinition(exchange: Exchange, market: SpreadMarket): ExchangeDefinition {
  if (market === 'oil') return oilDefinitions[exchange];
  if (exchange === 'hyperliquid') return { left: 'xyz:SKHY', right: 'xyz:SKHX', currency: 'USD', priceBasis: 'mid', fundingPriceBasis: 'oracle' };
  if (exchange === 'bybit' || exchange === 'binance') return { ...exchangeContracts.hynix, currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' };
  throw new Error('Unsupported exchange comparison market');
}
export const exchangeAction = (exchange: Exchange) => `exchanges/${exchange}/quote`;
export function exchangeFromAction(action: string): Exchange | null {
  return (['hyperliquid', ...externalExchanges] as const).find(exchange => action === exchangeAction(exchange)) ?? null;
}

export type ExchangeLeg = {
  symbol: string;
  price: number;
  fundingPrice: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  nextFundingAt: string | null;
  nextFundingEstimated?: boolean;
};
export type ExchangeQuote = {
  exchange: Exchange;
  monitorId: SpreadMarket;
  currency: "USD" | "USDT" | "USDC";
  priceBasis: "mid" | "mark";
  fundingPriceBasis: "oracle" | "index" | "mark";
  fetchedAt: string;
  /** Older adapters use source time. Some public APIs only expose receipt time. */
  timestampBasis?: "source" | "received";
  fundingFetchedAt: string | null;
  status: "live" | "snapshot";
  left: ExchangeLeg;
  right: ExchangeLeg;
  fundingError: string;
};
export type ExternalQuoteSet = Partial<Record<Exchange, ExchangeQuote | null>>;

export function calculateExchangeSpread(quote: ExchangeQuote) {
  const units = exchangeContracts[quote.monitorId].leftUnits;
  const left = quote.left, right = quote.right;
  const equivalent = right.price / units;
  const spread = left.price - equivalent, premium = quote.monitorId === "oil" ? oilSpreadPercent(left.price, right.price) ?? NaN : (left.price / equivalent - 1) * 100;
  const hasFunding = [left, right].every(leg => leg.fundingRate !== null && Number.isFinite(leg.fundingRate) && leg.fundingPrice !== null && leg.fundingPrice > 0 && leg.fundingIntervalHours !== null && leg.fundingIntervalHours > 0);
  const grossNotional = hasFunding ? units * left.fundingPrice! + right.fundingPrice! : null;
  const hourlyCashflow = hasFunding ? units * left.fundingPrice! * left.fundingRate! / left.fundingIntervalHours! - right.fundingPrice! * right.fundingRate! / right.fundingIntervalHours! : null;
  const shortAnnualized = grossNotional !== null && hourlyCashflow !== null ? hourlyCashflow / grossNotional * 8760 : null;
  if (![equivalent, spread, premium].every(Number.isFinite) || (shortAnnualized !== null && !Number.isFinite(shortAnnualized))) throw new Error("Invalid spread calculation");
  return { equivalent, spread, premium, shortAnnualized, longAnnualized: shortAnnualized === null ? null : -shortAnnualized };
}

export function externalQuoteStale(quote: ExchangeQuote, now: number) {
  const maxAge = quote.exchange === "hyperliquid" ? quote.monitorId === "oil" ? 75_000 : 25_000 : EXCHANGE_STALE_MS;
  // OKX publishes funding snapshots every 30–90s; quote freshness stays at 45s.
  const fundingMaxAge = quote.exchange === 'okx' ? 120_000 : maxAge;
  return quote.status === "snapshot" || now - Date.parse(quote.fetchedAt) > maxAge || (quote.fundingFetchedAt !== null && now - Date.parse(quote.fundingFetchedAt) > fundingMaxAge);
}

/** Runtime boundary shared by the collector and browser. Derived numbers are recomputed. */
export function validateExchangeQuote(input: unknown, exchange: ExternalExchange, monitorId: SpreadMarket): ExchangeQuote {
  if (!input || typeof input !== "object") throw new Error("Invalid exchange quote");
  if (!supportsExchange(monitorId, exchange)) throw new Error('Unsupported exchange comparison market');
  const value = input as ExchangeQuote, contracts = exchangeDefinition(exchange, monitorId);
  const stamp = (time: unknown) => typeof time === "string" && Number.isFinite(Date.parse(time));
  if (value.exchange !== exchange || value.monitorId !== monitorId || value.currency !== contracts.currency || value.priceBasis !== contracts.priceBasis || value.fundingPriceBasis !== contracts.fundingPriceBasis || !["live", "snapshot"].includes(value.status) || !stamp(value.fetchedAt) || (value.fundingFetchedAt !== null && !stamp(value.fundingFetchedAt)) || (value.timestampBasis !== undefined && !['source', 'received'].includes(value.timestampBasis))) throw new Error("Exchange quote identity mismatch");
  const leg = (input: ExchangeLeg, symbol: string): ExchangeLeg => {
    if (!input || input.symbol !== symbol || typeof input.price !== "number" || !Number.isFinite(input.price) || input.price <= 0) throw new Error("Invalid exchange contract price");
    if (contracts.fundingPriceBasis === 'mark' ? input.fundingPrice !== input.price : input.fundingPrice !== null && (typeof input.fundingPrice !== 'number' || !Number.isFinite(input.fundingPrice) || input.fundingPrice <= 0)) throw new Error('Invalid exchange funding price');
    if (input.fundingRate !== null && (typeof input.fundingRate !== "number" || !Number.isFinite(input.fundingRate) || Math.abs(input.fundingRate) > 1)) throw new Error("Invalid exchange funding rate");
    if (input.fundingIntervalHours !== null && (!Number.isInteger(input.fundingIntervalHours) || input.fundingIntervalHours < 1 || input.fundingIntervalHours > 24)) throw new Error("Invalid funding interval");
    if (input.nextFundingAt !== null && (!stamp(input.nextFundingAt) || Date.parse(input.nextFundingAt) < Date.parse(value.fetchedAt) - 60_000 || Date.parse(input.nextFundingAt) > Date.parse(value.fetchedAt) + 25 * 3_600_000)) throw new Error("Invalid funding settlement time");
    if (input.nextFundingEstimated !== undefined && typeof input.nextFundingEstimated !== 'boolean') throw new Error('Invalid settlement time basis');
    return { symbol, price: input.price, fundingPrice: input.fundingPrice, fundingRate: input.fundingRate, fundingIntervalHours: input.fundingIntervalHours, nextFundingAt: input.nextFundingAt, ...(input.nextFundingEstimated !== undefined ? { nextFundingEstimated: input.nextFundingEstimated } : {}) };
  };
  if (value.fundingFetchedAt !== null && Date.parse(value.fundingFetchedAt) > Date.parse(value.fetchedAt) + 60_000) throw new Error("Invalid funding receipt time");
  const quote: ExchangeQuote = { exchange, monitorId, currency: contracts.currency, priceBasis: contracts.priceBasis, fundingPriceBasis: contracts.fundingPriceBasis, fetchedAt: value.fetchedAt, ...(value.timestampBasis ? { timestampBasis: value.timestampBasis } : {}), fundingFetchedAt: value.fundingFetchedAt, status: value.status === "snapshot" ? "snapshot" : "live", left: leg(value.left, contracts.left), right: leg(value.right, contracts.right), fundingError: typeof value.fundingError === "string" ? value.fundingError : "" };
  if ([quote.left, quote.right].some(leg => leg.fundingRate !== null && (leg.fundingPrice === null || leg.fundingIntervalHours === null || leg.nextFundingAt === null || quote.fundingFetchedAt === null))) throw new Error("Incomplete funding metadata");
  calculateExchangeSpread(quote);
  return quote;
}

export function hynixExchangeQuote(quote: LiveQuote, stale = false): ExchangeQuote {
  const funding = quote.funding?.adr && quote.funding?.ordinary ? quote.funding : null;
  const leg = (symbol: string, price: number, fundingPrice?: number, fundingRate?: number): ExchangeLeg => ({ symbol, price, fundingPrice: fundingPrice ?? null, fundingRate: fundingRate ?? null, fundingIntervalHours: funding ? 1 : null, nextFundingAt: null });
  return { exchange: "hyperliquid", monitorId: "hynix", currency: "USD", priceBasis: "mid", fundingPriceBasis: "oracle", fetchedAt: quote.fetchedAt, fundingFetchedAt: funding?.fetchedAt ?? null, status: stale || quote.status === "snapshot" ? "snapshot" : "live", left: leg("xyz:SKHY", quote.adr, funding?.adr.oraclePx, funding?.adr.hourlyRate), right: leg("xyz:SKHX", quote.ordinary, funding?.ordinary.oraclePx, funding?.ordinary.hourlyRate), fundingError: funding ? "" : "资金费暂不可用" };
}

export function oilExchangeQuote(market: { fetchedAt: string; brent: { markPx: number; oraclePx: number; funding: number }; wti: { markPx: number; oraclePx: number; funding: number } }, stale = false): ExchangeQuote {
  const leg = (symbol: string, value: typeof market.brent): ExchangeLeg => ({ symbol, price: value.markPx, fundingPrice: value.oraclePx, fundingRate: value.funding, fundingIntervalHours: 1, nextFundingAt: null });
  return { exchange: "hyperliquid", monitorId: "oil", currency: "USD", priceBasis: "mark", fundingPriceBasis: "oracle", fetchedAt: market.fetchedAt, fundingFetchedAt: market.fetchedAt, status: stale ? "snapshot" : "live", left: leg("xyz:BRENTOIL", market.brent), right: leg("xyz:CL", market.wti), fundingError: "" };
}

export function binanceOilExchangeQuote(input: ReturnType<typeof validateMarket>, stale = false): ExchangeQuote {
  const market = validateMarket(input);
  const leg = (item: typeof market.brent): ExchangeLeg => ({ symbol: item.coin, price: item.markPx, fundingPrice: item.markPx, fundingRate: item.fundingRate, fundingIntervalHours: item.fundingIntervalHours, nextFundingAt: item.nextFundingAt });
  const complete = market.brent.fundingRate !== null && market.wti.fundingRate !== null;
  const hasFunding = market.brent.fundingRate !== null || market.wti.fundingRate !== null;
  return { exchange: 'binance', monitorId: 'oil', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark', fetchedAt: market.fetchedAt, fundingFetchedAt: hasFunding ? market.fetchedAt : null, status: stale ? 'snapshot' : 'live', left: leg(market.brent), right: leg(market.wti), fundingError: complete ? '' : '资金费或结算周期暂不可用，价格仍正常更新。' };
}

export function validateComparisonQuote(input: unknown, exchange: Exchange, monitorId: SpreadMarket): ExchangeQuote {
  if (exchange !== 'hyperliquid') return validateExchangeQuote(input, exchange, monitorId);
  const quote = input as ExchangeQuote;
  if (monitorId !== 'oil' || quote?.exchange !== exchange || quote.monitorId !== monitorId || quote.currency !== 'USD' || quote.priceBasis !== 'mark' || quote.fundingPriceBasis !== 'oracle' || !Number.isFinite(Date.parse(quote.fetchedAt)) || !['live', 'snapshot'].includes(quote.status)) throw new Error('Invalid Hyperliquid oil comparison');
  for (const [leg, symbol] of [[quote.left, 'xyz:BRENTOIL'], [quote.right, 'xyz:CL']] as const) {
    if (leg?.symbol !== symbol || !Number.isFinite(leg.price) || leg.price <= 0 || leg.fundingPrice === null || !Number.isFinite(leg.fundingPrice) || leg.fundingPrice <= 0 || leg.fundingRate === null || !Number.isFinite(leg.fundingRate) || Math.abs(leg.fundingRate) > 1 || leg.fundingIntervalHours !== 1) throw new Error('Invalid Hyperliquid comparison leg');
  }
  return quote;
}

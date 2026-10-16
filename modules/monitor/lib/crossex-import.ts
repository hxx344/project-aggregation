import { canonicalBase, crossexBase } from "../../../server/asset-identity.mjs";
import type { HubQuery } from "./hub-bridge.ts";
import { normalizedFunding8h, quoteIsFresh, quotePrice, type PerpetualSpread } from "./perpetual-spreads.ts";
import type { PerpetualPriceMode, PerpetualQuote } from "./perpetual-types.ts";

export type CrossExImportSelection = Pick<Required<HubQuery>, "symbol" | "longExchange" | "shortExchange" | "longContract" | "shortContract" | "opportunityKind">;
export interface CrossExImportOptions {
  connected: boolean;
  now: number;
  staleAfterMs: number;
  priceMode: PerpetualPriceMode;
  opportunityKind: "spread" | "funding";
}
export type CrossExImportResult = { query: CrossExImportSelection; reason: null } | { query: null; reason: string };

const venues = new Set(["binance", "bybit", "okx", "gate", "kraken", "hyperliquid", "lighter"]);
const basePattern = /^[A-Z0-9]{1,30}$/;

/** Recover the native base from the actual source contract, never the display/grouping base. */
function nativeContract(quote: PerpetualQuote): { nativeBase: string; counterCurrency: string } | null {
  const { exchange, symbol, quoteCurrency } = quote;
  let nativeBase: string | undefined;
  let counterCurrency = quoteCurrency;
  if (exchange === "binance" && ["USDT", "USDC"].includes(quoteCurrency)) {
    if (symbol.endsWith(quoteCurrency)) nativeBase = symbol.slice(0, -quoteCurrency.length);
  } else if (exchange === "bybit") {
    const suffix = quoteCurrency === "USDC" ? "PERP" : quoteCurrency === "USDT" ? "USDT" : null;
    if (suffix && symbol.endsWith(suffix)) nativeBase = symbol.slice(0, -suffix.length);
  } else if (exchange === "okx" && ["USDT", "USDC"].includes(quoteCurrency)) {
    const suffix = `-${quoteCurrency}-SWAP`;
    if (symbol.endsWith(suffix)) nativeBase = symbol.slice(0, -suffix.length);
  } else if (exchange === "gate" && quoteCurrency === "USDT" && symbol.endsWith("_USDT")) {
    nativeBase = symbol.slice(0, -5);
  } else if (exchange === "kraken" && quoteCurrency === "USD" && /^PF_[A-Z0-9]+USD$/.test(symbol)) {
    nativeBase = symbol.slice(3, -3);
    if (canonicalBase(exchange, nativeBase) === "BTC" && nativeBase !== "XBT") return null;
  } else if (exchange === "hyperliquid" && quoteCurrency === (["HYPE", "PURR"].includes(symbol) ? "USDC" : "USDT")) {
    nativeBase = symbol;
    counterCurrency = "USDC";
  } else if (exchange === "lighter" && quoteCurrency === "USDC") {
    nativeBase = symbol;
  }
  return nativeBase && basePattern.test(nativeBase) ? { nativeBase, counterCurrency } : null;
}

function importLeg(quote: PerpetualQuote): { base: string; contract: string } | string {
  if (!venues.has(quote.exchange)) return "该交易所暂不支持 CrossEx 导入";
  if (quote.multiplier !== 1) return "倍率合约暂不支持导入";
  if (quote.assetClass !== "crypto" || quote.comparable === false) return "仅支持身份可比较的加密资产合约";
  if (typeof quote.identitySource !== "string" || !quote.identitySource.trim()) return "合约身份资料不足";
  if (quote.delisting === true || (typeof quote.delistingAt === "number" && Number.isFinite(quote.delistingAt) && quote.delistingAt > 0)) return "合约已公告下架";
  const native = nativeContract(quote);
  if (!native || !basePattern.test(quote.base)) return "原生合约与计价币不匹配";
  const base = canonicalBase(quote.exchange, native.nativeBase);
  if (canonicalBase(quote.exchange, quote.base) !== base) return "原生合约与标的身份不匹配";
  // Kraken's instrument metadata may name BTC while its product id names XBT.
  if (quote.rawBase !== undefined && (typeof quote.rawBase !== "string" || !basePattern.test(quote.rawBase)
    || (quote.exchange === "kraken" ? canonicalBase(quote.exchange, quote.rawBase) !== base : quote.rawBase !== native.nativeBase))) return "原生币名与合约身份不匹配";
  const contract = `${quote.exchange.toUpperCase()}_FUTURE_${crossexBase(quote.exchange, native.nativeBase)}_${native.counterCurrency}`;
  if ((quote.crossexSymbol !== undefined && quote.crossexSymbol !== contract)
    || (quote.counterCurrency !== undefined && quote.counterCurrency !== native.counterCurrency)
    || (quote.settlementCurrency !== undefined && quote.settlementCurrency !== native.counterCurrency)) return "CrossEx 合约身份不一致";
  return { base, contract };
}

/** This is navigation identity only. CrossEx resolves current catalog eligibility before prefilling. */
export function prepareCrossExImport(row: Pick<PerpetualSpread, "base" | "long" | "short">, options: CrossExImportOptions): CrossExImportResult {
  const unavailable = (reason: string): CrossExImportResult => ({ query: null, reason });
  if (!options.connected) return unavailable("请从工作台打开后导入");
  const long = importLeg(row.long), short = importLeg(row.short);
  if (typeof long === "string") return unavailable(`多腿：${long}`);
  if (typeof short === "string") return unavailable(`空腿：${short}`);
  if (row.long.exchange === row.short.exchange || long.base !== short.base
    || canonicalBase(row.long.exchange, row.base) !== long.base || canonicalBase(row.short.exchange, row.base) !== short.base) return unavailable("双腿不是同一标的的跨所组合");
  for (const [side, quote] of [["多腿", row.long], ["空腿", row.short]] as const) {
    const sourceAt = options.priceMode === "book" ? quote.bidAskAt : quote.markAt;
    if ((typeof sourceAt === "number" && sourceAt > options.now + 5_000)
      || !quoteIsFresh(quote, options.priceMode, options.now, options.staleAfterMs)) return unavailable(`${side}报价已过期或时间无效，请刷新行情`);
    if (quotePrice(quote, options.priceMode, side === "多腿" ? "buy" : "sell") === null) return unavailable(`${side}报价暂不可用`);
    if (options.opportunityKind === "funding" && normalizedFunding8h(quote, options.now) === null) return unavailable(`${side}资金费资料已过期或不完整`);
  }
  return { query: { symbol: long.base, longExchange: row.long.exchange, shortExchange: row.short.exchange,
    longContract: long.contract, shortContract: short.contract, opportunityKind: options.opportunityKind }, reason: null };
}

/** Mint at click time so importing the same pair again is a distinct selection. */
export function createCrossExImportId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
}

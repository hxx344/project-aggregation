import { createHash } from 'node:crypto';
import { perpetualSpreadKey, quotePriceTime, rankPerpetualSpreads } from '../lib/perpetual-spreads.ts';
import { CROSS_EX_MAX_QUOTES, CROSS_EX_MAX_SIGNALS, CROSS_EX_STALE_MS } from '../lib/perpetual-opportunities.ts';

const supportedVenues = new Set(['binance', 'bybit']);
const filters = { search: '', exchanges: ['binance', 'bybit'], pairMode: 'cex-cex', priceMode: 'book', crossCurrency: false, minSpreadPercent: 0, favoritesOnly: false, favorites: [], sortBy: 'gross' };

/** Eligibility comes from the existing official directory, never symbol guessing. */
function supportedQuote(quote) {
  return supportedVenues.has(quote.exchange) && typeof quote.symbol === 'string' && quote.symbol.length > 0
    && typeof quote.base === 'string' && /^[A-Z0-9-]{1,40}$/.test(quote.base)
    && quote.quoteCurrency === 'USDT' && quote.collateralCurrency === 'USDT' && quote.multiplier === 1
    && quote.assetClass === 'crypto' && quote.identityVerified === true
    && typeof quote.identitySource === 'string' && quote.identitySource.length > 0
    && quote.comparable !== false && quote.delisting === false && quote.delistingAt === null;
}

const completeBook = quote => Number.isFinite(quote.bid) && Number.isFinite(quote.ask)
  && quote.bid > 0 && quote.ask >= quote.bid;

// Funding/mark refreshes and response generation must not invent a new BBO version.
const bookVersion = quote => [quote.exchange, quote.symbol, quote.base, quote.quoteCurrency,
  quote.collateralCurrency, quote.multiplier, quote.contractUnit ?? '', quote.assetClass,
  quote.identitySource, quote.bid, quote.ask, quotePriceTime(quote, 'book')];

/** Enrich only this response: existing paper identities must keep their old shape. */
function withDirectoryEvidence(quote, getMarket) {
  if (!getMarket) return quote;
  const market = getMarket(quote.exchange, quote.symbol);
  if (!market || market.exchange !== quote.exchange || market.symbol !== quote.symbol
    || market.base !== quote.base || market.quoteCurrency !== quote.quoteCurrency
    || market.multiplier !== quote.multiplier) return null;
  return { ...quote, assetClass: market.assetClass, identitySource: market.identitySource,
    identityVerified: market.identityVerified, collateralCurrency: market.collateralCurrency,
    ...(market.comparable === false ? { comparable: false } : {}),
  };
}

/** Synchronous projection of the shared snapshot: no network, storage or timers. */
export function createPerpetualOpportunities(snapshot, now = Date.now(), getMarket, filter) {
  const candidates = snapshot.quotes.filter(quote => supportedVenues.has(quote.exchange))
    .map(quote => withDirectoryEvidence(quote, getMarket)).filter(quote => quote && supportedQuote(quote));
  const binanceCrypto = new Set(candidates.filter(quote => quote.exchange === 'binance').map(quote => quote.base));
  const quotes = candidates.filter(quote => quote.exchange !== 'bybit' || binanceCrypto.has(quote.base));
  const result = {
    schemaVersion: 1, mode: 'paper', source: 'market-monitor', monitorId: 'perpetual',
    generatedAt: now, status: snapshot.status, staleAfterMs: CROSS_EX_STALE_MS,
    exchanges: snapshot.exchanges, quotes, signals: [],
    crossexFilter: { requireSpotTransfer: filter?.requireSpotTransfer ?? filter?.enabled ?? false, blockedBases: filter?.blockedBases ?? [], excluded: 0, revision: filter?.revision ?? 0 },
  };
  if (quotes.length > CROSS_EX_MAX_QUOTES) return {
    ...result, status: 'unavailable', quotes: [], errorCode: 'QUOTE_LIMIT_EXCEEDED',
    error: `支持市场报价数量 ${quotes.length} 超过 ${CROSS_EX_MAX_QUOTES} 上限，本次不返回部分报价或信号。`,
  };
  if (new Set(quotes.map(quote => `${quote.exchange}:${quote.symbol}`)).size !== quotes.length) return {
    ...result, status: 'unavailable', quotes: [], errorCode: 'DUPLICATE_QUOTES',
    error: '行情快照包含重复合约，无法确定报价版本。',
  };
  const ranked = rankPerpetualSpreads({ ...snapshot, staleAfterMs: CROSS_EX_STALE_MS, quotes: quotes.filter(completeBook) }, filters, now);
  result.signals = ranked.filter(row => row.spreadPercent > 0).flatMap(row => {
    const evidence = filter?.enabled ? filter.evaluate(row.long, row.short, now) : {};
    if (!evidence) { result.crossexFilter.excluded++; return []; }
    const pairKey = perpetualSpreadKey(row);
    const observedAt = Math.min(quotePriceTime(row.long, 'book'), quotePriceTime(row.short, 'book'));
    return {
      id: createHash('sha256').update(JSON.stringify([pairKey, bookVersion(row.long), bookVersion(row.short)])).digest('hex'),
      pairKey, base: row.base, quoteCurrency: 'USDT', long: row.long, short: row.short,
      grossSpreadPercent: row.spreadPercent, observedAt, expiresAt: Math.min(observedAt + CROSS_EX_STALE_MS, evidence.expiresAt ?? Infinity),
      ...(evidence.networks ? { spotTransfer: evidence } : {}),
    };
  }).filter(signal => result.crossexFilter.requireSpotTransfer ? now < signal.expiresAt : now <= signal.expiresAt).slice(0, CROSS_EX_MAX_SIGNALS);
  return result;
}

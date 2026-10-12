import { createHash } from 'node:crypto';
import { perpetualSpreadKey, quotePriceTime, rankPerpetualSpreads } from '../lib/perpetual-spreads.ts';
import { quoteCurrencyFx } from '../lib/perpetual-fx.ts';
import { CROSS_EX_MAX_QUOTES, CROSS_EX_MAX_SIGNALS, CROSS_EX_STALE_MS } from '../lib/perpetual-opportunities.ts';

export const CROSSEX_VENUES = Object.freeze(['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter']);

/** Reuse projections only for an unchanged source revision; expiry always uses original source time. */
export function createOpportunitiesV2Reader(project = createPerpetualOpportunitiesV2) {
  let previous;
  return (snapshot, now, getMarket, fx, sourceVersion, filter) => {
    const key = JSON.stringify([sourceVersion, fx, snapshot.storageError ?? null, snapshot.exchanges.map(x => [x.id, x.status]), filter?.version]);
    if (!previous || previous.key !== key || now < previous.at || now - previous.at >= 10_000) previous = { key, at: now, value: project(snapshot, now, getMarket, fx, filter) };
    const value = previous.value;
    return { ...value, generatedAt: now, status: value.errorCode ? value.status : snapshot.status,
      exchanges: snapshot.exchanges.filter(x => CROSSEX_VENUES.includes(x.id)),
      signals: value.signals.filter(signal => (value.crossexFilter?.requireSpotTransfer ? now < signal.expiresAt : now <= signal.expiresAt) && [signal.long, signal.short].every(q => snapshot.exchanges.some(x => x.id === q.exchange && x.status === 'live'))) };
  };
}
const filters = { search: '', exchanges: CROSSEX_VENUES, pairMode: 'all', priceMode: 'book', crossCurrency: true, minSpreadPercent: 0, favoritesOnly: false, favorites: [], sortBy: 'gross' };
const currencies = new Set(['USDT', 'USDC', 'USD']);

function enrich(quote, market) {
  if (!market || market.exchange !== quote.exchange || market.symbol !== quote.symbol || market.base !== quote.base || market.quoteCurrency !== quote.quoteCurrency || market.multiplier !== quote.multiplier) return null;
  if (market.multiplier !== 1 || !/^[A-Z0-9]{1,30}$/.test(market.base) || market.comparable === false || market.assetClass !== 'crypto' || market.delisting !== false || market.delistingAt !== null || !currencies.has(market.quoteCurrency)) return null;
  if (market.exchange === 'binance' || market.exchange === 'kraken') { if (market.identityVerified !== true) return null; }
  else if (market.crossexVerified !== true) return null;
  const special = market.exchange === 'hyperliquid', kraken = market.exchange === 'kraken';
  const settlementCurrency = special ? 'USDC' : market.quoteCurrency;
  return { ...quote, rawBase: market.rawBase ?? market.base, assetClass: market.assetClass,
    identityVerified: true, identitySource: market.identitySource, comparable: true,
    settlementCurrency, collateralCurrency: kraken ? 'MULTI' : settlementCurrency,
    contractKind: special && market.quoteCurrency !== 'USDC' ? 'quanto' : 'linear', counterCurrency: settlementCurrency,
    crossexSymbol: `${market.exchange.toUpperCase()}_FUTURE_${market.base}_${settlementCurrency}`,
    ...(market.exchange === 'lighter' ? { marketId: market.marketId } : {}),
    delisting: market.delisting, delistingAt: market.delistingAt,
  };
}
const version = q => [q.exchange, q.symbol, q.base, q.rawBase, q.quoteCurrency, q.settlementCurrency, q.collateralCurrency, q.contractKind, q.crossexSymbol, q.marketId ?? null, q.multiplier, q.identitySource, q.bid, q.ask, quotePriceTime(q, 'book')];
function ratesFor(legs, fx, now) {
  const needed = [...new Set(legs.flatMap(q => [q.quoteCurrency, q.settlementCurrency]))].sort();
  const entries = needed.map(currency => [currency, quoteCurrencyFx(currency, fx, now)]);
  return entries.some(([, rate]) => !rate || typeof rate.source !== 'string' || !rate.source || rate.at > now + 1000) ? null : entries;
}

/** Read-only projection; never refreshes a retained quote's source timestamp. */
export function createPerpetualOpportunitiesV2(snapshot, now = Date.now(), getMarket, fx = null, filter) {
  const markets = snapshot.quotes.filter(q => CROSSEX_VENUES.includes(q.exchange)).map(q => enrich(q, getMarket?.(q.exchange, q.symbol))).filter(Boolean);
  // Directory classification and an independent COIN market are both required.
  // Existing per-venue symbol collision exclusions run before this comparison.
  const crypto = new Set(markets.filter(q => q.exchange === 'binance').map(q => q.base));
  const quotes = markets.filter(q => q.exchange === 'binance' || crypto.has(q.base));
  const result = { schemaVersion: 2, mode: 'paper', source: 'market-monitor', monitorId: 'perpetual', generatedAt: now,
    status: snapshot.status, staleAfterMs: CROSS_EX_STALE_MS, exchanges: snapshot.exchanges.filter(x => CROSSEX_VENUES.includes(x.id)), quotes, signals: [], fx,
    crossexFilter: { requireSpotTransfer: filter?.requireSpotTransfer ?? filter?.enabled ?? false, blockedBases: filter?.blockedBases ?? [], excluded: 0, revision: filter?.revision ?? 0 },
    ...(snapshot.storageError ? { storageError: snapshot.storageError } : {}),
  };
  if (quotes.length > CROSS_EX_MAX_QUOTES || new Set(quotes.map(q => `${q.exchange}:${q.symbol}`)).size !== quotes.length) return { ...result, status: 'unavailable', quotes: [], errorCode: quotes.length > CROSS_EX_MAX_QUOTES ? 'QUOTE_LIMIT_EXCEEDED' : 'DUPLICATE_QUOTES', error: '支持市场报价超出上限或存在重复合约，本次不发布部分信号。' };
  if (snapshot.storageError) return result;
  const eligible = quotes.filter(q => Number.isFinite(q.bid) && q.bid > 0 && Number.isFinite(q.ask) && q.ask >= q.bid && quotePriceTime(q, 'book') <= now + 1000 && ratesFor([q], fx, now));
  const ranked = rankPerpetualSpreads({ ...snapshot, staleAfterMs: CROSS_EX_STALE_MS, quotes: eligible }, filters, now, undefined, fx);
  result.signals = ranked.flatMap(row => {
    const evidence = filter?.enabled ? filter.evaluate(row.long, row.short, now) : {};
    if (!evidence) { result.crossexFilter.excluded++; return []; }
    const legs = [row.long, row.short], rates = ratesFor(legs, fx, now), pairKey = perpetualSpreadKey(row);
    const longRate = quoteCurrencyFx(row.long.quoteCurrency, fx, now), shortRate = quoteCurrencyFx(row.short.quoteCurrency, fx, now);
    const referenceBuyPrice = row.long.ask * longRate.ask, referenceSellPrice = row.short.bid * shortRate.bid;
    const observedAt = Math.min(...legs.map(q => quotePriceTime(q, 'book')));
    const fxVersions = rates.filter(([currency]) => currency !== 'USDT').map(([currency, rate]) => [currency, rate.bid, rate.ask, rate.at, rate.source]);
    const expiresAt = Math.min(observedAt + CROSS_EX_STALE_MS, evidence.expiresAt ?? Infinity, ...fxVersions.map(row => row[3] + Math.min(180000, fx.staleAfterMs)));
    return { id: createHash('sha256').update(JSON.stringify([pairKey, legs.map(version), fxVersions])).digest('hex'), pairKey, base: row.base, quoteCurrency: 'USDT', long: row.long, short: row.short,
      grossSpreadPercent: (referenceSellPrice / referenceBuyPrice - 1) * 100, referenceBuyPrice, referenceSellPrice, observedAt, expiresAt,
      ...(evidence.networks ? { spotTransfer: evidence } : {}) };
  }).filter(row => (result.crossexFilter.requireSpotTransfer ? now < row.expiresAt : now <= row.expiresAt) && row.grossSpreadPercent > 0).sort((a, b) => b.grossSpreadPercent - a.grossSpreadPercent || a.pairKey.localeCompare(b.pairKey)).slice(0, CROSS_EX_MAX_SIGNALS);
  return result;
}

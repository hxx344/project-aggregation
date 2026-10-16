import { canonicalBase } from './asset-identity.mjs';

export const HUB_QUERY_KEYS = Object.freeze(['symbol', 'longExchange', 'shortExchange', 'longContract', 'shortContract', 'opportunityKind', 'importId']);
const venues = new Set(['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter']);
const importKeys = ['longContract', 'shortContract', 'opportunityKind', 'importId'];

/** Navigation carries a selection only; order inputs and arbitrary destinations are never accepted. */
export function cleanHubQuery(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const query = {};
  for (const [key, value] of Object.entries(input)) {
    if (!HUB_QUERY_KEYS.includes(key) || typeof value !== 'string') return null;
    if (key === 'symbol' && !/^[A-Z0-9._-]{1,40}$/.test(value)) return null;
    if (key.endsWith('Exchange') && !venues.has(value)) return null;
    if (key.endsWith('Contract') && !/^[A-Z]+_FUTURE_[A-Z0-9]{1,30}_(USDT|USDC|USD)$/.test(value)) return null;
    if (key === 'opportunityKind' && !['spread', 'funding'].includes(value)) return null;
    if (key === 'importId' && !/^[A-Za-z0-9_-]{1,80}$/.test(value)) return null;
    query[key] = value;
  }
  if (importKeys.some(key => Object.hasOwn(query, key))) {
    if (HUB_QUERY_KEYS.some(key => !query[key]) || query.longExchange === query.shortExchange) return null;
    for (const side of ['long', 'short']) {
      const [exchange, , base] = query[side + 'Contract'].split('_');
      if (exchange.toLowerCase() !== query[side + 'Exchange'] || canonicalBase(exchange.toLowerCase(), base) !== query.symbol) return null;
    }
  }
  return query;
}

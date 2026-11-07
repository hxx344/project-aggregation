export const TRADING_EXCHANGES = Object.freeze(['binance', 'bybit', 'okx']);
export const TRADING_SYMBOLS = Object.freeze(['CLUSDT', 'BZUSDT']);
/** Live execution venues. The read-only ledger, imports and automatic rules keep TRADING_EXCHANGES. */
export const EXECUTION_EXCHANGES = Object.freeze([...TRADING_EXCHANGES, 'hyperliquid', 'rh-lighter']);
/** Execution-only markets. The read-only oil ledger keeps TRADING_SYMBOLS. */
export const EXECUTION_MARKETS = Object.freeze({
  oil: Object.freeze({ name: '原油', symbols: Object.freeze(['CLUSDT', 'BZUSDT']) }),
  hynix: Object.freeze({ name: '海力士', symbols: Object.freeze(['SKHYUSDT', 'SKHYNIXUSDT']) }),
  // Hyperliquid HIP-3 symbols keep their native `dex:coin` names (Entropy io, trade.xyz); Lighter RH lists ANTHROPIC.
  anthropic: Object.freeze({ name: 'Anthropic', symbols: Object.freeze(['ANTHROPICUSDT', 'io:ANTH', 'xyz:ANT', 'ANTHROPIC']) }),
});
/** SK hynix positions are observed with the read-only accounts; their funding and PnL stay out of the oil ledger. */
export const TRADING_HYNIX_SYMBOLS = EXECUTION_MARKETS.hynix.symbols;
/** Anthropic legs on the read-only accounts (Bybit lists no Anthropic contract); positions only, outside the oil ledger. */
export const TRADING_ANTHROPIC_SYMBOLS = Object.freeze(['ANTHROPICUSDT']);
export const TRADING_ANTHROPIC_EXCHANGES = Object.freeze(['binance', 'okx']);
export const EXECUTION_ALL_SYMBOLS = Object.freeze(Object.values(EXECUTION_MARKETS).flatMap(market => market.symbols));
const CEX_SYMBOLS = [...EXECUTION_MARKETS.oil.symbols, ...EXECUTION_MARKETS.hynix.symbols];
/** Contracts each venue actually lists; every leg, quote and account read is limited to these. */
export const EXECUTION_VENUE_SYMBOLS = Object.freeze({
  binance: Object.freeze([...CEX_SYMBOLS, 'ANTHROPICUSDT']),
  bybit: Object.freeze([...CEX_SYMBOLS]),
  okx: Object.freeze([...CEX_SYMBOLS, 'ANTHROPICUSDT']),
  hyperliquid: Object.freeze(['io:ANTH', 'xyz:ANT']),
  'rh-lighter': Object.freeze(['ANTHROPIC']),
});
export const venueSupports = (exchange, symbol) => typeof exchange === 'string' && Object.hasOwn(EXECUTION_VENUE_SYMBOLS, exchange) && EXECUTION_VENUE_SYMBOLS[exchange].includes(symbol);
/** Symbols an account snapshot reads; omitted means every allowed symbol. Returns null when invalid. */
export function executionSymbols(value, allowed = EXECUTION_ALL_SYMBOLS) {
  if (value === undefined) return [...allowed];
  if (!Array.isArray(value) || value.length === 0 || value.some(symbol => !allowed.includes(symbol))) return null;
  return allowed.filter(symbol => value.includes(symbol));
}
export const TRADING_NAMES = Object.freeze({ binance: 'Binance', bybit: 'Bybit', okx: 'OKX', hyperliquid: 'Hyperliquid', 'rh-lighter': 'Lighter RH' });export const DEFAULT_TRADING_PAIR = Object.freeze(['binance', 'bybit']);
export const TRADING_PAIRS = Object.freeze([
  DEFAULT_TRADING_PAIR, Object.freeze(['binance', 'okx']), Object.freeze(['bybit', 'okx']),
]);

/** A pair is a selection, not a request to change any account or running job. */
export function normalizeTradingPair(value = DEFAULT_TRADING_PAIR) {
  const pair = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1] || pair.some(exchange => !TRADING_EXCHANGES.includes(exchange))) throw new Error('Invalid trading pair');
  return TRADING_EXCHANGES.filter(exchange => pair.includes(exchange));
}
export const tradingPairKey = value => normalizeTradingPair(value).join(',');

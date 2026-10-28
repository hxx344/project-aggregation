export const TRADING_EXCHANGES = Object.freeze(['binance', 'bybit', 'okx']);
export const TRADING_SYMBOLS = Object.freeze(['CLUSDT', 'BZUSDT']);
/** Execution-only markets. The read-only oil ledger keeps TRADING_SYMBOLS. */
export const EXECUTION_MARKETS = Object.freeze({
  oil: Object.freeze({ name: '原油', symbols: Object.freeze(['CLUSDT', 'BZUSDT']) }),
  hynix: Object.freeze({ name: '海力士', symbols: Object.freeze(['SKHYUSDT', 'SKHYNIXUSDT']) }),
});
export const EXECUTION_ALL_SYMBOLS = Object.freeze(Object.values(EXECUTION_MARKETS).flatMap(market => market.symbols));
/** Symbols an account snapshot reads; omitted means every execution symbol. Returns null when invalid. */
export function executionSymbols(value) {
  if (value === undefined) return [...EXECUTION_ALL_SYMBOLS];
  if (!Array.isArray(value) || value.length === 0 || value.some(symbol => !EXECUTION_ALL_SYMBOLS.includes(symbol))) return null;
  return EXECUTION_ALL_SYMBOLS.filter(symbol => value.includes(symbol));
}
export const TRADING_NAMES = Object.freeze({ binance: 'Binance', bybit: 'Bybit', okx: 'OKX' });
export const DEFAULT_TRADING_PAIR = Object.freeze(['binance', 'bybit']);
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

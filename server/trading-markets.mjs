export const TRADING_EXCHANGES = Object.freeze(['binance', 'bybit', 'okx']);
export const TRADING_SYMBOLS = Object.freeze(['CLUSDT', 'BZUSDT']);
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

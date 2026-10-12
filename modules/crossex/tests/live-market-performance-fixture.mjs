import { defaults, pairKey } from '../server/model.mjs';
import { quote, feed, catalog, epoch } from './fixtures.mjs';

// The requested pairs live at the end of both large directories so a repeated
// scan cannot pass the operation-count regression simply by finding them early.
export function largeMarketData({ instrument = false, now = epoch } = {}) {
  const reads = { quoteSymbols: 0, catalogSymbols: 0, signalLegs: 0 };
  const quotes = [], items = [], signals = [];
  const count = (value, property, counter) => {
    const stored = value[property];
    Object.defineProperty(value, property, { enumerable: true, configurable: true, get() { reads[counter]++; return stored; } });
  };
  for (let i = 0; i < 2500; i++) {
    const base = `COIN${i}`, legs = ['binance', 'bybit'].map(exchange => quote(exchange, now, { base, symbol: `${base}USDT` }));
    for (const [index, q] of legs.entries()) {
      const rule = { ...catalog[index], symbol: `${q.exchange.toUpperCase()}_FUTURE_${base}_USDT`, max_limit_size: '10000' };
      if (instrument) { count(q, 'symbol', 'quoteSymbols'); count(rule, 'symbol', 'catalogSymbols'); }
      quotes.push(q); items.push(rule);
    }
    if (i >= 2400) for (const [long, short] of [legs, [legs[1], legs[0]]]) {
      const signal = { id: `${base}-${long.exchange}-${now}`, base, quoteCurrency: 'USDT', long, short, observedAt: now, expiresAt: now + 10000 };
      signal.pairKey = pairKey(signal);
      if (instrument) { count(signal, 'long', 'signalLegs'); count(signal, 'short', 'signalLegs'); }
      signals.push(signal);
    }
  }
  return { snapshot: { ...feed(now), quotes, signals }, catalog: items, reads,
    resetReads() { for (const name of Object.keys(reads)) reads[name] = 0; } };
}

// No persistence or network overhead obscures the cost of market refresh/view.
export function memoryMarketStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get: (key, fallback = null) => values.has(key) ? values.get(key) : fallback,
    set: (key, value) => values.set(key, value), config: () => ({ ...defaults, ...values.get('config') }),
    decrypt: value => value || '', encrypt: value => value, transaction: fn => fn() };
}

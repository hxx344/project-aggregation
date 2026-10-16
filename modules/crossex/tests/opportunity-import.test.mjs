import test from 'node:test';
import assert from 'node:assert/strict';
import { instrumentBase, opportunityImportPair } from '../src/opportunity-import.ts';

const instrument = (exchange, base, currency, extra = {}) => ({
  symbol: `${exchange.toUpperCase()}_FUTURE_${base}_${currency}`, exchange, base,
  quoteCurrency: currency, settlementCurrency: currency, lot_size: '0.001', min_size: '0.001', tick_size: '0.1', ...extra,
});
const long = instrument('bybit', 'BTC', 'USDC'), short = instrument('binance', 'BTC', 'USDT');
const query = { symbol: 'BTC', longExchange: 'bybit', shortExchange: 'binance', longContract: long.symbol,
  shortContract: short.symbol, opportunityKind: 'spread', importId: 'first-import' };

test('an import keeps its exact directional contracts and each contract counter currency', () => {
  const instruments = [instrument('bybit', 'BTC', 'USDT'), short, long];
  assert.deepEqual(opportunityImportPair(query, instruments), { long, short });
  assert.deepEqual(opportunityImportPair({ ...query, opportunityKind: 'funding', importId: 'second-import' }, instruments), { long, short });
  assert.deepEqual(opportunityImportPair({ ...query, longExchange: query.shortExchange, shortExchange: query.longExchange,
    longContract: query.shortContract, shortContract: query.longContract }, instruments), { long: short, short: long });
});

test('catalog loading, missing legs and removed contracts never substitute a similar contract', () => {
  for (const instruments of [[], [long], [short], [instrument('bybit', 'BTC', 'USDT'), short], [long, instrument('gate', 'BTC', 'USDT')]]) {
    assert.equal(opportunityImportPair(query, instruments), null);
  }
  assert.deepEqual(opportunityImportPair(query, [long, short]), { long, short });
  assert.equal(opportunityImportPair(query, [short]), null);
  assert.deepEqual(opportunityImportPair(query, [long, short]), { long, short });
});

test('catalog and import identities must agree on exchange, base and currency', () => {
  for (const change of [{ exchange: 'gate' }, { base: 'ETH' }, { quoteCurrency: 'USDT' }, { state: 'delisted' }]) {
    assert.equal(opportunityImportPair(query, [{ ...long, ...change }, short]), null);
  }
  for (const change of [{ symbol: 'ETH' }, { longExchange: 'gate' }, { longContract: 'BYBIT_FUTURE_ETH_USDC' },
    { longContract: 'BINANCE_FUTURE_BTC_USDC' }, { shortExchange: 'bybit', shortContract: long.symbol }]) {
    assert.equal(opportunityImportPair({ ...query, ...change }, [long, short]), null);
  }
  for (const field of Object.keys(query)) {
    const partial = { ...query }; delete partial[field];
    assert.equal(opportunityImportPair(partial, [long, short]), null);
  }
});

test('verified venue aliases keep their native contracts while grouping the canonical base', () => {
  const gate = instrument('gate', 'LUNA', 'USDT'), binance = instrument('binance', 'LUNA2', 'USDT');
  const aliasQuery = { ...query, symbol: 'LUNA2', longExchange: 'gate', longContract: gate.symbol, shortContract: binance.symbol };
  assert.equal(instrumentBase(gate), 'LUNA2');
  assert.equal(instrumentBase(binance), 'LUNA2');
  assert.deepEqual(opportunityImportPair(aliasQuery, [gate, binance]), { long: gate, short: binance });
  assert.equal(opportunityImportPair(aliasQuery, [{ ...gate, base: 'LUNC' }, binance]), null);
  assert.equal(opportunityImportPair({ ...aliasQuery, longExchange: 'bybit', longContract: 'BYBIT_FUTURE_LUNA_USDT' },
    [instrument('bybit', 'LUNA', 'USDT'), binance]), null);
  const kraken = instrument('kraken', 'BTC', 'USD');
  assert.deepEqual(opportunityImportPair({ ...query, longExchange: 'kraken', longContract: kraken.symbol }, [kraken, short]), { long: kraken, short });
});

test('Hyperliquid imports match CrossEx USDC counter currency without interpreting a native USDT quote', () => {
  const hyperliquid = instrument('hyperliquid', 'BTC', 'USDC');
  const imported = { ...query, longExchange: 'hyperliquid', longContract: hyperliquid.symbol };
  assert.deepEqual(opportunityImportPair(imported, [hyperliquid, short]), { long: hyperliquid, short });
  assert.equal(opportunityImportPair(imported, [{ ...hyperliquid, quoteCurrency: 'USDT' }, short]), null);
});

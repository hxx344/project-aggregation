import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanHubQuery, HUB_QUERY_KEYS } from '../server/hub-navigation.mjs';
import { navigation } from '../src/hub-state.ts';
import { cleanHubQuery as monitorQuery, hubSelectionUrl } from '../modules/monitor/lib/hub-bridge.ts';
import { cleanHubQuery as crossexQuery } from '../modules/crossex/src/hub-bridge.ts';

const query = { symbol: 'BTC', longExchange: 'binance', shortExchange: 'bybit', longContract: 'BINANCE_FUTURE_BTC_USDT', shortContract: 'BYBIT_FUTURE_BTC_USDC', opportunityKind: 'funding', importId: 'fixture-1' };

test('host and both module bridges preserve exact selections and reject incomplete or executable payloads', () => {
  for (const clean of [cleanHubQuery, monitorQuery, crossexQuery]) {
    assert.deepEqual(clean(query), query);
    assert.deepEqual(clean({ symbol: 'BTC' }), { symbol: 'BTC' });
    for (const key of HUB_QUERY_KEYS) { const partial = { ...query }; delete partial[key]; assert.equal(clean(partial), null, key); }
    for (const patch of [{ quantity: '1' }, { action: 'open' }, { leverage: '10' }, { url: 'https://example.test' }, { importId: 'a'.repeat(81) }, { opportunityKind: 'execute' }, { longContract: 'BYBIT_FUTURE_BTC_USDT' }, { longContract: 'BINANCE_FUTURE_ETH_USDT' }, { shortExchange: 'binance', shortContract: 'BINANCE_FUTURE_BTC_USDC' }]) assert.equal(clean({ ...query, ...patch }), null);
  }
  assert.deepEqual(navigation({ projectId: 'crossex', query }), { projectId: 'crossex', query });
  for (const projectId of ['monitor', 'asset', 'greeks', 'https://example.test']) assert.equal(navigation({ projectId, query }), null);
});

test('known aliases and counter currencies retain exact CrossEx identity', () => {
  const luna = { ...query, symbol: 'LUNA2', longExchange: 'gate', longContract: 'GATE_FUTURE_LUNA_USDT', shortContract: 'BYBIT_FUTURE_LUNA2_USDC' };
  assert.deepEqual(cleanHubQuery(luna), luna);
  assert.equal(cleanHubQuery({ ...luna, symbol: 'LUNC' }), null);
  const hyperliquid = { ...query, shortExchange: 'hyperliquid', shortContract: 'HYPERLIQUID_FUTURE_BTC_USDC' };
  assert.deepEqual(cleanHubQuery(hyperliquid), hyperliquid);
});

test('a later ordinary navigation clears every import field from the previous URL', () => {
  const url = new URL('http://local.test/?monitor=perpetual&goldOil=bz');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const next = new URL(hubSelectionUrl(url.href, 'monitor', { symbol: 'ETH' }));
  assert.equal(next.searchParams.get('symbol'), 'ETH');
  assert.equal(next.searchParams.get('goldOil'), 'bz');
  for (const key of HUB_QUERY_KEYS.filter(key => key !== 'symbol')) assert.equal(next.searchParams.has(key), false, key);
});

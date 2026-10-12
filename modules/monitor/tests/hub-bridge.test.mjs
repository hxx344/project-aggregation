import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedHubOrigin, cleanHubQuery, observeNetworkActivity, hubSelectionUrl } from '../lib/hub-bridge.ts';

test('bridge trusts only the exact isolated proxy hostname, matching scheme and port', () => {
  const hostname = 'p-' + 'a'.repeat(24) + '.hub.localhost';
  assert.equal(trustedHubOrigin({ hostname, protocol: 'http:', port: '3100' }, true), 'http://hub.localhost:3100');
  assert.equal(trustedHubOrigin({ hostname, protocol: 'https:', port: '' }, true), 'https://hub.localhost');
  for (const name of ['hub.localhost', hostname + '.evil.example', 'evil.localhost', 'p-' + 'a'.repeat(23) + '.hub.localhost']) assert.equal(trustedHubOrigin({ hostname: name, protocol: 'http:', port: '' }, true), null);
  assert.equal(trustedHubOrigin({ hostname, protocol: 'http:', port: '3100' }, false), null);
  assert.equal(trustedHubOrigin({ hostname, protocol: 'javascript:', port: '' }, true), null);
});

test('navigation accepts only a bounded symbol and known venues, with no operation fields', () => {
  const query = { symbol: 'BTC', longExchange: 'binance', shortExchange: 'bybit' };
  assert.deepEqual(cleanHubQuery(query), query); assert.deepEqual(cleanHubQuery({}), {});
  for (const input of [null, [], { symbol: 'btc' }, { symbol: 'A'.repeat(41) }, { symbol: '<script>' }, { longExchange: 'unknown' }, { action: 'open' }, { url: 'https://evil.example' }]) assert.equal(cleanHubQuery(input), null);
});


test('network transitions update activity immediately and are detached when the module leaves', () => {
  const source = new EventTarget(), transitions = []; let online = true;
  const stop = observeNetworkActivity(() => transitions.push(online), source);
  online = false; source.dispatchEvent(new Event('offline')); assert.deepEqual(transitions, [false]);
  online = true; source.dispatchEvent(new Event('online')); assert.deepEqual(transitions, [false, true]);
  stop(); source.dispatchEvent(new Event('offline')); source.dispatchEvent(new Event('online'));
  assert.deepEqual(transitions, [false, true]);
});

test('a new host asset selection leaves the old chart and replaces only navigation fields', () => {
  const current = 'https://local.example/?monitor=perpetual&perpView=chart&chartBase=BTC&chartLong=binance%3ABTCUSDT&chartShort=aster%3ABTCUSDT&chartDays=30&symbol=BTC&longExchange=binance&goldOil=bz';
  const next = new URL(hubSelectionUrl(current, 'monitor', { symbol: 'ETH', shortExchange: 'bybit' }));
  assert.equal(next.searchParams.get('symbol'), 'ETH'); assert.equal(next.searchParams.get('shortExchange'), 'bybit');
  assert.equal(next.searchParams.get('monitor'), 'perpetual'); assert.equal(next.searchParams.get('goldOil'), 'bz');
  for (const key of ['perpView', 'chartBase', 'chartLong', 'chartShort', 'chartDays', 'longExchange']) assert.equal(next.searchParams.has(key), false);
});

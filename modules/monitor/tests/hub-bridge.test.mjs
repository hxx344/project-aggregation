import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedHubOrigin, cleanHubQuery, observeNetworkActivity, hubSelectionUrl, MODULE_CAPABILITIES, hostCapabilityList, canUseHostCapability, isHubMessage, cleanPositionsRequest, parsePositionsReply, createPositionsRequester } from '../lib/hub-bridge.ts';
import { oilSpreadPairs } from '../lib/related-pairs.ts';

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

test('module declares positions and open-trading; host capabilities are sanitized and required', () => {
  for (const capability of ['activity', 'navigate', 'changed', 'positions', 'open-trading']) assert.ok(MODULE_CAPABILITIES.includes(capability));
  assert.deepEqual(hostCapabilityList(['activity', 'positions', 'positions', 7, 'Bad Value', 'open-trading']), ['activity', 'positions', 'open-trading']);
  assert.deepEqual(hostCapabilityList(undefined), []); assert.deepEqual(hostCapabilityList('positions'), []);
  assert.equal(canUseHostCapability(true, ['activity', 'navigate'], 'positions'), false, 'old hosts never receive positions requests');
  assert.equal(canUseHostCapability(false, ['positions'], 'positions'), false, 'no request before the host handshake');
  assert.equal(canUseHostCapability(true, ['positions'], 'open-trading'), false);
  assert.equal(canUseHostCapability(true, ['positions', 'open-trading'], 'open-trading'), true);
});

test('host messages must come from the direct parent at the trusted origin with the hub envelope', () => {
  const parent = {}, origin = 'http://hub.localhost:3100', data = { channel: 'project-hub', version: 1, type: 'positions' };
  assert.equal(isHubMessage({ source: parent, origin, data }, origin, parent), true);
  assert.equal(isHubMessage({ source: {}, origin, data }, origin, parent), false, 'sibling or nested frames are rejected');
  assert.equal(isHubMessage({ source: parent, origin: 'http://evil.localhost:3100', data }, origin, parent), false);
  assert.equal(isHubMessage({ source: parent, origin, data }, null, parent), false, 'standalone pages trust nobody');
  for (const bad of [null, 'positions', { ...data, channel: 'other' }, { ...data, version: 2 }]) assert.equal(isHubMessage({ source: parent, origin, data: bad }, origin, parent), false);
});

test('positions requests carry a bounded market and validated base codes', () => {
  assert.deepEqual(cleanPositionsRequest('oil', ['CL', 'BZ', 'CL']), { market: 'oil', symbols: ['CL', 'BZ'] });
  assert.deepEqual(cleanPositionsRequest('perpetual', ['btc', 'ETH', 'A-B', 'X'.repeat(21), 'SOL']), { market: 'perpetual', symbols: ['ETH', 'SOL'] });
  assert.equal(cleanPositionsRequest('perpetual', Array.from({ length: 30 }, (_, index) => `C${index}`)).symbols.length, 20);
  for (const [market, symbols] of [['stocks', ['CL']], ['oil', []], ['oil', ['cl']], ['oil', 'CL']]) assert.equal(cleanPositionsRequest(market, symbols), null);
});

const item = (overrides = {}) => ({ key: 'k1', source: 'Gate CrossEx', exchange: 'Binance', symbol: 'CLUSDT', base: 'CL', side: 'long', quantity: '10', quantityUnit: '张', entryPrice: '70.10', markPrice: null, unrealizedPnl: '-1.5', pnlCurrency: 'USDT', updatedAt: '2026-10-20T08:00:00.000Z', stale: false, ...overrides });
const reply = (overrides = {}) => ({ channel: 'project-hub', version: 1, type: 'positions', requestId: 'req-1', market: 'oil', status: 'ok', generatedAt: '2026-10-20T08:00:01.000Z', items: [item()], ...overrides });

test('positions replies keep only redacted fields, string values and nulls as sent', () => {
  const parsed = parsePositionsReply(reply({ items: [item({ accountId: 'secret', revision: 9 })] }));
  assert.deepEqual(parsed.items, [item()]);
  assert.equal(parsed.items[0].markPrice, null, 'missing mark price is never turned into 0');
  assert.equal('accountId' in parsed.items[0], false);
  assert.deepEqual(parsePositionsReply(reply({ status: 'unauthorized', items: [], generatedAt: null })).items, []);
  for (const bad of [
    reply({ type: 'position' }), reply({ requestId: 'bad id' }), reply({ requestId: 'x'.repeat(65) }), reply({ market: 'stocks' }), reply({ status: 'error' }),
    reply({ generatedAt: 'yesterday' }), reply({ items: 'none' }), reply({ items: Array.from({ length: 51 }, () => item()) }),
    reply({ items: [item({ side: 'buy' })] }), reply({ items: [item({ quantity: 10 })] }), reply({ items: [item({ entryPrice: 70.1 })] }),
    reply({ items: [item({ stale: 'no' })] }), reply({ items: [item({ base: 'cl' })] }),
  ]) assert.equal(parsePositionsReply(bad), null);
});

test('only the latest request id resolves, later or foreign replies are ignored and silence times out', () => {
  const sent = [], replies = [], timers = new Map(); let id = 0, nextTimer = 0;
  const requester = createPositionsRequester({
    send: message => sent.push(message), onReply: value => replies.push(value), timeoutMs: 12_000,
    schedule: (callback, ms) => { const handle = ++nextTimer; timers.set(handle, { callback: () => { timers.delete(handle); callback(); }, ms }); return handle; },
    cancel: handle => timers.delete(handle), createId: () => `req-${++id}`,
  });
  assert.equal(requester.request('oil', ['cl']), null, 'invalid symbols send nothing'); assert.equal(sent.length, 0);
  requester.request('oil', ['CL', 'BZ']); requester.request('oil', ['CL', 'BZ']);
  assert.deepEqual(sent.map(message => message.requestId), ['req-2', 'req-3']);
  assert.deepEqual(sent[1], { type: 'positions-request', requestId: 'req-3', market: 'oil', symbols: ['CL', 'BZ'] });
  assert.equal(timers.size, 1, 'a newer request replaces the older timeout');
  assert.equal(requester.receive(reply({ requestId: 'req-2' })), false, 'superseded request is ignored');
  assert.equal(requester.receive({ type: 'positions', requestId: 'req-3' }), false, 'malformed reply is ignored');
  assert.equal(requester.receive(reply({ requestId: 'req-3' })), true);
  assert.equal(requester.receive(reply({ requestId: 'req-3' })), false, 'duplicates after resolution are ignored');
  assert.equal(replies.length, 1); assert.equal(timers.size, 0);
  requester.request('perpetual', ['BTC']);
  const [timer] = timers.values(); assert.equal(timer.ms, 12_000);
  timer.callback();
  assert.deepEqual(replies.at(-1), { requestId: 'req-4', market: 'perpetual', status: 'unavailable', generatedAt: null, incomplete: false, items: [], timedOut: true });
  assert.equal(requester.receive(reply({ requestId: 'req-4', market: 'perpetual' })), false, 'a reply after timeout is ignored');
  requester.request('hynix', ['SKHY']); requester.dispose(); assert.equal(timers.size, 0);
  assert.equal(requester.receive(reply({ requestId: 'req-5', market: 'hynix' })), false);
});

test('incomplete is accepted as a boolean, defaults to false for older hosts and only applies to ok replies', () => {
  assert.equal(parsePositionsReply(reply()).incomplete, false, 'an older host without the flag is treated as complete');
  assert.equal(parsePositionsReply(reply({ incomplete: false })).incomplete, false);
  assert.equal(parsePositionsReply(reply({ incomplete: true })).incomplete, true);
  assert.equal(parsePositionsReply(reply({ incomplete: true, items: [] })).items.length, 0, 'an empty incomplete list is still a valid reply');
  assert.equal(parsePositionsReply(reply({ status: 'unavailable', items: [], generatedAt: null, incomplete: true })).incomplete, false);
  for (const bad of ['yes', 1, null]) assert.equal(parsePositionsReply(reply({ incomplete: bad })), null);
});

test('an optional stable exchange id is kept only when well formed', () => {
  assert.equal(parsePositionsReply(reply({ items: [item({ exchangeId: 'binance' })] })).items[0].exchangeId, 'binance');
  assert.equal('exchangeId' in parsePositionsReply(reply()).items[0], false);
  for (const bad of ['Binance', 'bin ance', 7, 'x'.repeat(41)]) assert.equal(parsePositionsReply(reply({ items: [item({ exchangeId: bad })] })), null);
});

test('oil spreads pair only one CL and one BZ position in opposite directions on the same venue', () => {
  const cl = (overrides = {}) => item({ key: `cl-${Math.random()}`, symbol: 'CLUSDT', base: 'CL', side: 'long', entryPrice: '62.10', ...overrides });
  const bz = (overrides = {}) => item({ key: `bz-${Math.random()}`, symbol: 'BZUSDT', base: 'BZ', side: 'short', entryPrice: '65.80', ...overrides });
  const spreads = { binance: { premium: 5.68, stale: false } };
  const [paired] = oilSpreadPairs([cl(), bz()], spreads);
  assert.equal(paired.status, 'paired');
  assert.ok(Math.abs(paired.opening - (65.8 - 62.1) / 62.1 * 100) < 1e-9);
  assert.equal(paired.current, 5.68, 'the current spread is looked up by the normalized venue');
  assert.equal(oilSpreadPairs([cl({ exchange: 'Binance ' }), bz({ exchange: 'BINANCE' })], spreads).length, 1, 'display names are normalized before grouping');
  assert.deepEqual(oilSpreadPairs([cl(), bz({ side: 'long' })], spreads).map(pair => [pair.status, pair.reason]), [['unpaired', 'same-side']]);
  assert.deepEqual(oilSpreadPairs([cl(), cl(), bz()], spreads).map(pair => [pair.status, pair.reason]), [['unpaired', 'multiple']]);
  assert.deepEqual(oilSpreadPairs([cl()], spreads).map(pair => [pair.status, pair.reason]), [['unpaired', 'missing-leg']]);
  const venues = oilSpreadPairs([cl(), bz({ exchange: 'Bybit' })], spreads);
  assert.deepEqual(venues.map(pair => pair.status), ['unpaired', 'unpaired'], 'legs on different venues are never mixed');
  assert.ok(venues.every(pair => !('opening' in pair)), 'unpaired venues expose no spread numbers');
  assert.equal(oilSpreadPairs([cl({ exchangeId: 'bybit' }), bz({ exchangeId: 'bybit' })], spreads)[0].current, null, 'a host exchange id takes precedence over the display name');
  assert.equal(oilSpreadPairs([cl({ entryPrice: null }), bz()], spreads)[0].opening, null, 'a missing entry price stays unknown');
});

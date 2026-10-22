import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedHubOrigin, cleanHubQuery, observeNetworkActivity, hubSelectionUrl, MODULE_CAPABILITIES, hostCapabilityList, canUseHostCapability, isHubMessage, cleanPositionsRequest, parsePositionsReply, createPositionsRequester } from '../lib/hub-bridge.ts';
import { relatedSpreadPairs, RELATED_SYMBOLS } from '../lib/related-pairs.ts';
import { exchangeContracts } from '../lib/exchange-quotes.ts';

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

test('a host that revalidates the frame gets the unanswered request again, and an answered one is not repeated', () => {
  const sent = [], replies = [], timers = new Map(); let id = 0, nextTimer = 0;
  const requester = createPositionsRequester({
    send: message => sent.push(message), onReply: value => replies.push(value), timeoutMs: 20_000,
    schedule: (callback, ms) => { const handle = ++nextTimer; timers.set(handle, { callback, ms }); return handle; },
    cancel: handle => timers.delete(handle), createId: () => `req-${++id}`,
  });
  assert.equal(requester.retry(), null, 'nothing to repeat before the first request');
  requester.request('oil', ['CL', 'BZ']);
  assert.equal(requester.retry(), 'req-2');
  assert.deepEqual(sent.at(-1), { type: 'positions-request', requestId: 'req-2', market: 'oil', symbols: ['CL', 'BZ'] });
  assert.equal(timers.size, 1, 'the repeated request restarts a single deadline');
  assert.equal(requester.receive(reply({ requestId: 'req-1' })), false, 'the dropped request no longer resolves');
  assert.equal(requester.receive(reply({ requestId: 'req-2' })), true);
  assert.equal(requester.retry(), null, 'an answered request is not sent again'); assert.equal(sent.length, 2);
  requester.request('hynix', ['SKHY']); [...timers.values()][0].callback();
  assert.equal(replies.at(-1).timedOut, true);
  assert.equal(requester.retry(), null, 'a timed-out request waits for the next refresh');
  requester.request('perpetual', ['BTC']); requester.dispose();
  assert.equal(requester.retry(), null, 'nothing is sent after dispose'); assert.equal(sent.length, 4);
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
  const oilSpreadPairs = (items, values) => relatedSpreadPairs('oil', items, values);
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

test('Hynix pairs one ADR and one ordinary-share leg per venue using the 10 ADR to 1 share premium', () => {
  const adr = (overrides = {}) => item({ key: `adr-${Math.random()}`, symbol: 'SKHYUSDT', base: 'SKHY', side: 'short', entryPrice: '141.68', ...overrides });
  const ordinary = (overrides = {}) => item({ key: `ord-${Math.random()}`, symbol: 'SKHYNIXUSDT', base: 'SKHYNIX', side: 'long', entryPrice: '959.75', ...overrides });
  const spreads = { binance: { premium: 46.2, stale: true } };
  const [paired] = relatedSpreadPairs('hynix', [adr(), ordinary()], spreads);
  assert.equal(paired.status, 'paired');
  assert.ok(Math.abs(paired.opening - (141.68 / (959.75 / 10) - 1) * 100) < 1e-9, 'matches the live comparison formula');
  assert.equal(paired.current, 46.2); assert.equal(paired.currentStale, true);
  const [hyperliquid] = relatedSpreadPairs('hynix', [adr({ exchangeId: 'hyperliquid' }), ordinary({ exchangeId: 'hyperliquid', base: 'SKHX', symbol: 'xyz:SKHX' })], spreads);
  assert.equal(hyperliquid.status, 'paired', 'SKHX is the ordinary-share leg'); assert.equal(hyperliquid.current, null, 'no quote for that venue');
  assert.deepEqual(relatedSpreadPairs('hynix', [ordinary({ exchange: 'Aster', side: 'short' }), ordinary({ exchange: 'Aster' })], spreads).map(pair => [pair.status, pair.reason]), [['unpaired', 'missing-leg']]);
  assert.deepEqual(relatedSpreadPairs('hynix', [adr(), adr(), ordinary()], spreads).map(pair => pair.reason), ['multiple']);
  assert.deepEqual(relatedSpreadPairs('hynix', [adr({ side: 'long' }), ordinary()], spreads).map(pair => pair.reason), ['same-side']);
  for (const entryPrice of [null, '0', 'abc']) assert.equal(relatedSpreadPairs('hynix', [adr(), ordinary({ entryPrice })], spreads)[0].opening, null);
  assert.deepEqual(relatedSpreadPairs('oil', [adr(), ordinary()], spreads), [], 'other markets ignore Hynix legs');
  assert.equal(paired.narrowingFavors, true, 'short ADR (the numerator) profits when the premium falls');
  assert.equal(relatedSpreadPairs('hynix', [adr({ side: 'long' }), ordinary({ side: 'short' })], spreads)[0].narrowingFavors, false);
});

test('paired legs add up unrealized and realized results and show the closing spread', () => {
  const cycle = (overrides = {}) => ({ status: 'complete', since: '2026-10-01T13:40:00.000Z', closedQuantity: '500', closePrice: '97.912', realizedPnl: '3416.58823527', fees: '-37.13599997', funding: '1701.40490575', net: '5080.85714105', currency: 'USDT', note: null, updatedAt: '2026-10-20T08:00:00.000Z', ...overrides });
  const cl = (overrides = {}) => item({ key: 'cl', symbol: 'CLUSDT', base: 'CL', side: 'long', entryPrice: '91.07882352941174', unrealizedPnl: '10142.71680071', cycle: cycle(), ...overrides });
  const bz = (overrides = {}) => item({ key: 'bz', symbol: 'BZUSDT', base: 'BZ', side: 'short', entryPrice: '101.4829411764706', unrealizedPnl: '-9066.40914424', cycle: cycle({ closePrice: '105.766', realizedPnl: '-2141.52941173', fees: '-25.13735598', funding: '-4640.21922683', net: '-6806.88599454' }), ...overrides });
  const near = (actual, expected) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);
  const [pair] = relatedSpreadPairs('oil', [cl(), bz()], { binance: { premium: 9.545, stale: false } });
  near(pair.closing, (105.766 - 97.912) / 97.912 * 100);
  near(pair.change, 9.545 - pair.opening);
  assert.equal(pair.narrowingFavors, true, 'long CL / short BZ profits when the spread narrows');
  const t = pair.totals;
  assert.equal(t.realizedStatus, 'complete'); assert.equal(t.unrealizedCurrency, 'USDT'); assert.equal(t.realizedCurrency, 'USDT');
  near(t.unrealized, 10142.71680071 - 9066.40914424); near(t.realized, 3416.58823527 - 2141.52941173);
  near(t.fees, -37.13599997 - 25.13735598); near(t.funding, 1701.40490575 - 4640.21922683);
  near(t.net, 5080.85714105 - 6806.88599454); near(t.total, t.unrealized + t.net);
  assert.equal(relatedSpreadPairs('oil', [cl({ side: 'short' }), bz({ side: 'long' })], undefined)[0].narrowingFavors, false);

  const totals = (clOver, bzOver) => relatedSpreadPairs('oil', [cl(clOver), bz(bzOver)], undefined)[0];
  const loading = totals({}, { cycle: cycle({ status: 'loading', closePrice: null, net: null }) });
  assert.equal(loading.totals.realizedStatus, 'loading'); assert.equal(loading.totals.net, null); assert.equal(loading.totals.total, null); assert.equal(loading.closing, null);
  near(loading.totals.unrealized, 10142.71680071 - 9066.40914424);
  for (const missing of [undefined, null, cycle({ status: 'unavailable' })]) assert.equal(totals({}, { cycle: missing }).totals.realizedStatus, 'unavailable');
  const mixed = totals({}, { cycle: cycle({ currency: 'USDC' }) });
  assert.equal(mixed.totals.realizedStatus, 'mixed-currency'); assert.equal(mixed.totals.realized, null, 'USDT and USDC are never added');
  const unrealizedMixed = totals({}, { pnlCurrency: 'USDC' });
  assert.equal(unrealizedMixed.totals.unrealized, null); assert.equal(unrealizedMixed.totals.total, null);
  const partial = totals({}, { cycle: cycle({ status: 'partial', net: null }) });
  assert.equal(partial.totals.realizedStatus, 'partial'); assert.equal(partial.totals.net, null, 'an unknown leg net leaves the pair net unknown'); assert.ok(partial.totals.realized !== null);
  assert.equal(totals({}, { cycle: cycle({ closedQuantity: '0' }) }).closing, null, 'no closing spread before both legs closed something');
  assert.equal(totals({}, { stale: true }).totals.unrealizedStale, true);
});test('related position requests cover both legs of every compared contract pair', () => {
  for (const [market, contract] of Object.entries(exchangeContracts))
    for (const base of [contract.leftBase, contract.rightBase]) assert.ok(RELATED_SYMBOLS[market].includes(base), `${market} requests ${base}`);
});

test('an optional cycle summary is copied field by field and malformed summaries reject the reply', () => {
  const cycle = { status: 'complete', since: '2026-10-19T08:00:00.000Z', closedQuantity: '4', closePrice: '70.25', realizedPnl: '12.5', fees: '-0.4', funding: '0.2', net: '12.3', currency: 'USDT', note: null, updatedAt: '2026-10-20T08:00:00.000Z' };
  assert.deepEqual(parsePositionsReply(reply({ items: [item({ cycle: { ...cycle, secret: 'x' } })] })).items[0].cycle, cycle);
  assert.equal(parsePositionsReply(reply({ items: [item({ cycle: null })] })).items[0].cycle, null);
  assert.equal('cycle' in parsePositionsReply(reply()).items[0], false, 'older hosts send no summary');
  for (const bad of [{ ...cycle, status: 'done' }, { ...cycle, net: 12.3 }, { ...cycle, note: 'x'.repeat(301) }, 'complete']) assert.equal(parsePositionsReply(reply({ items: [item({ cycle: bad })] })), null);
});

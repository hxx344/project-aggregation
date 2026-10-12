import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPerpetualService, mergePerpetualQuote, createPerpetualDelta, createPerpetualPatch, createPerpetualChangedPatch } from '../server/perpetual-service.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';
import { createHandler } from '../server/http.mjs';
import { createSubscriptions, parseMessage, getControlResponse } from '../modules/perpetual/exchanges.mjs';
import { perpetualPriceIdentity } from '../lib/perpetual-price-history.ts';

const update = (patch = {}) => ({ exchange: 'test', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: 100, ask: 101, sourceTime: 1000, ...patch });

test('field patches preserve independent prices and refresh unchanged book times without full quote payloads', () => {
  const snapshot = quotes => ({ schemaVersion: 1, monitorId: 'perpetual', generatedAt: 1000, quotes });
  const first = mergePerpetualQuote(null, update(), 1000), previous = new Map();
  assert.deepEqual(createPerpetualPatch(snapshot([first]), previous).patches, [['test:BTCUSDT', first]]);
  const repeated = mergePerpetualQuote(first, update({ sourceTime: 2000 }), 2000);
  assert.equal(createPerpetualPatch(snapshot([repeated]), previous).patches.length, 0);
  const changed = mergePerpetualQuote(repeated, update({ bid: 100.5, sourceTime: 2100 }), 2100);
  const patch = createPerpetualPatch(snapshot([changed]), previous).patches[0][1];
  assert.deepEqual(patch, { bid: 100.5, bidAt: 2100, bidAskAt: 2100, receivedAt: 2100, sourceTime: 2100 });
  assert.equal(previous.get('test:BTCUSDT').askAt, 1000, 'Unchanged confirmations have their own cadence');
  const confirmed = mergePerpetualQuote(changed, update({ bid: 100.5, sourceTime: 5000 }), 5000);
  const confirmation = createPerpetualPatch(snapshot([confirmed]), previous).patches[0][1];
  assert.equal(confirmation.bidAskAt, 5000);
  assert.equal(confirmation.receivedAt, 5000);
  assert.equal(Object.hasOwn(confirmation, 'base'), false);
  assert.equal(Object.hasOwn(confirmation, 'bid'), false);
  const fundingOnly = mergePerpetualQuote(confirmed, update({ bid: undefined, ask: undefined, fundingRate: 0.001, sourceTime: 6000 }), 6000);
  const fundingPatch = createPerpetualPatch(snapshot([fundingOnly]), previous).patches[0][1];
  assert.equal(fundingPatch.fundingAt, 6000);
  assert.equal(Object.hasOwn(fundingPatch, 'bidAskAt'), false);
  assert.deepEqual(createPerpetualPatch(snapshot([]), previous).removed, ['test:BTCUSDT']);
});

test('identity resets explicitly clear old wire price timestamps', () => {
  const first = mergePerpetualQuote(null, update(), 1000), previous = new Map([['test:BTCUSDT', first]]);
  const next = mergePerpetualQuote(first, update({ base: 'OTHER', bid: undefined, ask: undefined, mark: 12, sourceTime: 6000 }), 6000);
  const patch = createPerpetualPatch({ quotes: [next] }, previous).patches[0][1];
  assert.equal(patch.base, 'OTHER'); assert.equal(patch.bid, null); assert.equal(patch.bidAskAt, null);
  assert.equal(previous.get('test:BTCUSDT').bidAt, null);
});

test('dirty-only patches match full baseline semantics for additions, deletions, metadata and paced confirmations', () => {
  const a = mergePerpetualQuote(null, update(), 1000), b = mergePerpetualQuote(null, update({ symbol: 'ETHUSDT', base: 'ETH' }), 1000);
  const initial = new Map([['test:BTCUSDT', a], ['test:ETHUSDT', b]]), full = new Map(initial), incremental = new Map(initial);
  let quotes = new Map(initial);
  const check = keys => {
    const metadata = { schemaVersion: 1, monitorId: 'perpetual', generatedAt: 5000, sequence: 4, exchanges: [{ id: 'test', status: 'live' }] };
    const expected = createPerpetualPatch({ ...metadata, quotes: [...quotes.values()] }, full);
    const actual = createPerpetualChangedPatch(metadata, quotes, incremental, keys);
    assert.deepEqual(actual, expected); assert.deepEqual(incremental, full);
  };
  quotes.set('test:BTCUSDT', mergePerpetualQuote(a, update({ sourceTime: 1100 }), 1100)); check(new Set(['test:BTCUSDT']));
  quotes.set('test:BTCUSDT', { ...quotes.get('test:BTCUSDT'), delisting: true, takerFeeRate: 0.0005, takerFeeAt: 1200 }); check(new Set(['test:BTCUSDT']));
  quotes.delete('test:ETHUSDT'); check(new Set(['test:ETHUSDT']));
  quotes.set('test:BTCUSDT', mergePerpetualQuote(quotes.get('test:BTCUSDT'), update({ sourceTime: 5000 }), 5000)); check(new Set(['test:BTCUSDT']));
  const c = mergePerpetualQuote(null, update({ symbol: 'SOLUSDT', base: 'SOL', sourceTime: 5000 }), 5000); quotes.set('test:SOLUSDT', c); check(new Set(['test:SOLUSDT']));
  check(new Set());
});

test('incremental frames send changed values, pace time confirmations and remove delisted quotes', () => {
  const first = mergePerpetualQuote(null, update(), 1000), previous = new Map();
  const snapshot = quotes => ({ schemaVersion: 1, monitorId: 'perpetual', generatedAt: 2000, quotes });
  assert.deepEqual(createPerpetualDelta(snapshot([first]), previous).updates, [first]);
  const unchanged = mergePerpetualQuote(first, update({ sourceTime: 2000 }), 2000);
  assert.equal(createPerpetualDelta(snapshot([unchanged]), previous).updates.length, 0);
  const changed = mergePerpetualQuote(unchanged, update({ bid: 100.5, sourceTime: 2001 }), 2001);
  assert.deepEqual(createPerpetualDelta(snapshot([changed]), previous).updates, [changed]);
  const confirmed = mergePerpetualQuote(changed, update({ bid: 100.5, sourceTime: 5000 }), 5000);
  assert.equal(createPerpetualDelta(snapshot([confirmed]), previous).updates.length, 1);
  const removed = createPerpetualDelta(snapshot([]), previous);
  assert.deepEqual(removed.removed, ['test:BTCUSDT']); assert.equal(previous.size, 0);
});

test('price fields retain their own age across sparse funding and mark updates', () => {
  const first = mergePerpetualQuote(null, update(), 1000);
  const funding = mergePerpetualQuote(first, update({ bid: undefined, ask: undefined, fundingRate: 0, fundingIntervalHours: 4, sourceTime: 2000 }), 2000);
  assert.equal(funding.bidAskAt, 1000);
  assert.equal(funding.fundingRate, 0);
  assert.equal(funding.fundingAt, 2000);
  const mark = mergePerpetualQuote(funding, update({ bid: undefined, ask: undefined, mark: 102, sourceTime: 3000 }), 3000);
  assert.equal(mark.bidAskAt, 1000);
  assert.equal(mark.markAt, 3000);
  assert.equal(mergePerpetualQuote(mark, update({ bid: 99, sourceTime: 500 }), 3000), mark);
  assert.equal(mergePerpetualQuote(mark, update({ sourceTime: 999999 }), 3000), mark);
  const missing = mergePerpetualQuote(mark, update({ bid: null, ask: undefined, sourceTime: 4000 }), 4000);
  assert.equal(missing.bid, null);
  assert.equal(missing.ask, 101);
});

test('funding schedules do not refresh old rates and changed contract identities clear old prices', () => {
  const initial = mergePerpetualQuote(null, update({ fundingRate: 0.001, fundingIntervalHours: 8 }), 1000);
  const schedule = mergePerpetualQuote(initial, update({ bid: undefined, ask: undefined, fundingIntervalHours: 4, nextFundingAt: 3600000, sourceTime: 2000 }), 2000);
  assert.equal(schedule.fundingAt, 1000);
  assert.equal(schedule.fundingRate, null, 'An old 8-hour rate must not be relabeled as a new 4-hour rate');
  assert.equal(schedule.fundingIntervalHoursUpdatedAt, 2000);
  assert.equal(schedule.nextFundingAtUpdatedAt, 2000);
  const changed = mergePerpetualQuote(schedule, update({ base: 'DIFFERENT', quoteCurrency: 'USDC', multiplier: 1000, bid: undefined, ask: undefined, mark: 12, sourceTime: 3000 }), 3000);
  assert.equal(changed.base, 'DIFFERENT');
  assert.equal(changed.quoteCurrency, 'USDC');
  assert.equal(changed.multiplier, 1000);
  assert.equal(changed.bid, null);
  assert.equal(changed.ask, null);
  assert.equal(changed.fundingRate, null);
  assert.equal(changed.mark, 12);
});

test('late REST funding cannot revive an old rate after a newer WS funding interval change', () => {
  const initial = mergePerpetualQuote(null, update({ fundingRate: 0.001, fundingIntervalHours: 8 }), 1000);
  const schedule = mergePerpetualQuote(initial, update({ bid: undefined, ask: undefined, fundingIntervalHours: 4, sourceTime: 3000 }), 3000);
  assert.equal(schedule.fundingRate, null);
  assert.equal(schedule.fundingIntervalHours, 4);
  assert.equal(schedule.fundingIntervalHoursUpdatedAt, 3000);
  assert.equal(schedule.fundingAt, 1000, 'A new interval is not a new rate confirmation');

  const delayed = mergePerpetualQuote(schedule, update({ fundingRate: 0.002, fundingIntervalHours: 8, sourceTime: 2000, transport: 'rest' }), 3500);
  assert.equal(delayed.fundingRate, null, 'An earlier 8-hour REST rate must not be combined with the newer 4-hour interval');
  assert.equal(delayed.fundingIntervalHours, 4);
  assert.equal(delayed.fundingIntervalHoursUpdatedAt, 3000);
  assert.equal(delayed.fundingAt, 1000);
  assert.equal(delayed.bidAskAt, 2000, 'The delayed response may still confirm older independent book fields');

  const confirmed = mergePerpetualQuote(delayed, update({ fundingRate: 0.003, fundingIntervalHours: 4, sourceTime: 4000, transport: 'rest' }), 4500);
  assert.equal(confirmed.fundingRate, 0.003);
  assert.equal(confirmed.fundingIntervalHours, 4);
  assert.equal(confirmed.fundingIntervalHoursUpdatedAt, 4000);
  assert.equal(confirmed.fundingAt, 4000, 'Recovery keeps the actual confirmation time, not the local receipt time');
});

test('latest quotes survive restart with original timestamps and delisted instruments are pruned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-test-'));
  let store;
  try {
    const filename = join(directory, 'market.sqlite');
    store = await openPerpetualStore(filename);
    const quote = { ...mergePerpetualQuote(null, update(), 1000), delisting: true, delistingAt: 200000 };
    store.save([quote]); store.close();
    store = await openPerpetualStore(filename);
    assert.deepEqual(store.load(), [quote]);
    store.prune('different', new Set()); assert.equal(store.load().length, 1);
    store.prune('test', new Set()); assert.equal(store.load().length, 0);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated market updates reuse latest rows and bound retained SQLite journal space', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-test-'));
  let store, inspection;
  try {
    const filename = join(directory, 'market.sqlite');
    store = await openPerpetualStore(filename);
    const values = Array.from({ length: 1000 }, (_, index) => mergePerpetualQuote(null, update({ symbol: `ASSET${index}USDT`, sourceTime: 1800000000000 }), 1800000000000));
    store.save(values);
    inspection = new DatabaseSync(filename);
    inspection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const initialBytes = (await stat(filename)).size;
    for (let batch = 0; batch < 60; batch++) store.save(values.map(quote => ({ ...quote, bid: 101 + batch % 2, receivedAt: 1800000000000 + batch * 15000 })));
    assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM quotes').get().count, 1000);
    const journalBytes = (await stat(`${filename}-wal`)).size;
    assert.ok(journalBytes <= 4194304 + initialBytes * 2, `journal ${journalBytes} bytes exceeds checkpoint plus one batch`);
    inspection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok((await stat(filename)).size <= initialBytes * 2, 'Database must not grow with update count');
    assert.equal((await stat(`${filename}-wal`)).size, 0);
    store.prune('test', new Set(values.slice(0, 50).map(quote => quote.symbol)));
    assert.equal(store.load().length, 50);
  } finally {
    inspection?.close(); store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

function setup(overrides = {}) {
  const sockets = [], saved = [];
  class Socket extends EventTarget {
    readyState = 0;
    sent = [];
    constructor(url) { super(); this.url = url; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const service = createPerpetualService({
    exchanges: [{ id: 'test', name: 'Test', kind: 'cex' }],
    discover: async () => [update()], subscriptions: (_id, markets) => [{ url: 'wss://example.invalid', subscribe: [{ subscribe: true }], markets }],
    parse: (_id, payload) => Array.isArray(payload) ? payload : [], control: () => null,
    WebSocketImpl: Socket, saveIntervalMs: 5, broadcastIntervalMs: 10, observationIntervalMs: 0, retryMs: 5,
    store: { load: () => [], save: values => saved.push(...values), prune() {}, close() {} }, ...overrides,
  });
  return { service, sockets, saved };
}
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); } assert.fail('Condition did not become true'); }

async function sampledSetup(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1_789_820_000_000;
  const startedAt = now;
  const fixture = setup({ clock: () => now, observationIntervalMs: undefined, saveIntervalMs: 60_000, broadcastIntervalMs: 500, ...overrides });
  t.after(() => fixture.service.stop()); fixture.service.start();
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(0);
  for (const socket of fixture.sockets) socket.open();
  return { ...fixture, startedAt, now: () => now, async advance(ms) { now += ms; t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(0); } };
}

test('one-second observations merge sparse updates once per contract without clients or renewed timestamps', async t => {
  const f = await sampledSetup(t);
  const socket = f.sockets[0], firstAt = f.now();
  socket.message([update({ sourceTime: firstAt }), update({ symbol: 'ETHUSDT', base: 'ETH', sourceTime: firstAt })]);
  await f.advance(200);
  socket.message([update({ bid: 100.5, ask: undefined, sourceTime: f.now() })]);
  await f.advance(200);
  socket.message([update({ bid: undefined, ask: undefined, fundingRate: 0, sourceTime: f.now() })]);
  assert.equal(f.service.snapshot().quotes.length, 0);
  assert.equal(f.service.metrics().pendingObservations, 2);
  assert.equal(f.service.metrics().updates, 4);
  assert.equal(f.service.metrics().venues[0].lastMessageAt, f.now(), 'Watchdog health is recorded before sampling');
  await f.advance(599); assert.equal(f.service.metrics().observations, 0);
  await f.advance(1);
  const quote = f.service.snapshot().quotes.find(row => row.symbol === 'BTCUSDT');
  assert.equal(quote.bid, 100.5); assert.equal(quote.ask, 101); assert.equal(quote.fundingRate, 0);
  assert.equal(quote.bidAt, firstAt + 200); assert.equal(quote.askAt, firstAt);
  assert.equal(quote.bidAskAt, firstAt); assert.equal(quote.fundingAt, firstAt + 400);
  assert.equal(quote.receivedAt, firstAt + 400); assert.equal(quote.sourceTime, firstAt + 400);
  assert.equal(f.service.metrics().observations, 2); assert.equal(f.service.metrics().clients, 0);
  await f.advance(31_000);
  assert.deepEqual(f.service.snapshot().quotes.find(row => row.symbol === 'BTCUSDT'), quote);
  assert.equal(f.service.snapshot().exchanges[0].quoteCount, 0, 'Sampling never renews an old source');
  assert.equal(f.service.metrics().observations, 2);
});

test('pending observations use current catalog metadata and cannot resurrect removed or reidentified contracts', async t => {
  let catalog = [update({ takerFeeRate: 0.001, takerFeeAt: 1000 })];
  const f = await sampledSetup(t, { discoveryIntervalMs: 500, discover: async () => catalog });
  const oldSocket = f.sockets[0];
  oldSocket.message([update({ sourceTime: f.now() })]);
  catalog = [update({ takerFeeRate: 0.002, takerFeeAt: f.now() })];
  await f.advance(500); await f.advance(500);
  assert.equal(f.service.snapshot().quotes[0].takerFeeRate, 0.002);
  assert.equal(f.service.snapshot().quotes[0].receivedAt, f.startedAt);
  oldSocket.message([update({ bid: 102, ask: 103, sourceTime: f.now() })]);
  catalog = [update({ symbol: 'ETHUSDT', base: 'ETH' })];
  await f.advance(500);
  oldSocket.message([update({ bid: 104, ask: 105, sourceTime: f.now() })]);
  await f.advance(500);
  assert.equal(f.service.snapshot().quotes.length, 0); assert.equal(f.service.metrics().pendingObservations, 0);
  const nextSocket = f.sockets.at(-1); nextSocket.open();
  nextSocket.message([update({ symbol: 'ETHUSDT', base: 'ETH', sourceTime: f.now() })]);
  catalog = [update({ symbol: 'ETHUSDT', base: 'DIFFERENT', multiplier: 1000 })];
  await f.advance(500); await f.advance(500);
  assert.equal(f.service.snapshot().quotes.length, 0, 'Buffered data from an old contract identity is discarded');
});

test('shutdown persists the last accepted observation and late socket messages cannot revive it', async t => {
  const f = await sampledSetup(t);
  f.sockets[0].message([update({ sourceTime: f.now() })]);
  assert.equal(f.saved.length, 0); assert.equal(f.service.snapshot().quotes.length, 0);
  await f.service.stop();
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].receivedAt, f.startedAt);
  f.sockets[0].message([update({ bid: 104, ask: 105, sourceTime: f.now() })]);
  await f.advance(2000);
  assert.equal(f.saved.length, 1); assert.equal(f.service.snapshot().quotes[0].bid, 100);
  assert.equal(f.service.metrics().pendingObservations, 0);
});

test('SSE joins and backpressure retain their baseline across independent observation intervals', async t => {
  const f = await sampledSetup(t);
  const reader = () => Object.assign(new EventEmitter(), {
    packets: [], writableLength: 0, writableNeedDrain: false, destroyed: false, writableEnded: false,
    writeHead() {}, write(message) { this.packets.push(JSON.parse(message.split('data: ')[1].trim())); },
    end() { this.writableEnded = true; this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
  });
  const existing = reader(); f.service.stream({ headers: {} }, existing);
  f.sockets[0].message([update({ sourceTime: f.now() })]);
  await f.advance(500); assert.equal(existing.packets.at(-1).patches.length, 0);
  await f.advance(500); assert.equal(existing.packets.at(-1).patches[0][1].bid, 100);
  f.sockets[0].message([update({ bid: 100.5, sourceTime: f.now() })]);
  const joining = reader(); f.service.stream({ headers: {} }, joining);
  assert.equal(joining.packets[0].quotes[0].bid, 100);
  f.sockets[0].message([update({ sourceTime: f.now() })]);
  await f.advance(1000);
  assert.ok(joining.packets.slice(1).every(packet => !packet.patches.some(([, row]) => row.bid === 100.5)));
  existing.writableNeedDrain = true;
  f.sockets[0].message([update({ bid: 100.25, sourceTime: f.now() })]);
  await f.advance(1000); existing.writableNeedDrain = false;
  await f.advance(500);
  assert.equal(existing.packets.at(-1).type, undefined);
  assert.equal(existing.packets.at(-1).quotes[0].bid, 100.25);
  for (let index = 1; index < joining.packets.length; index++) assert.equal(joining.packets[index].baseSequence, joining.packets[index - 1].sequence);
});

test('cached metric action is wired to current catalogs, persists once and does not renew quote times', async t => {
  const now = Date.UTC(2026, 9, 8), savedMetrics = [], savedHistory = [];
  let reads = 0;
  const quotes = ['first', 'second'].map(exchange => update({ exchange, sourceTime: now }));
  const { service, sockets } = setup({ clock: () => now,
    exchanges: quotes.map(quote => ({ id: quote.exchange, name: quote.exchange, kind: 'cex' })),
    discover: async exchange => quotes.filter(quote => quote.exchange === exchange),
    store: { load: () => [], save() {}, prune() {}, close() {}, loadContractMetrics: () => [], saveContractMetrics: entry => savedMetrics.push(entry), loadFundingHistory: () => [], saveFundingHistory: entry => savedHistory.push(entry) },
    marketMetricsOptions: { reader: async () => { reads++; return { volume24h: { value: 0, currency: 'USDT', observedAt: now, source: 'official', error: '' }, openInterest: { value: 123, currency: 'USDT', observedAt: now, source: 'official', error: '' } }; }, hostSpacingMs: 0 },
  });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 2);
  sockets.forEach((socket, index) => { socket.open(); socket.message([quotes[index]]); });
  const input = { pairs: [{ base: 'BTC', longKey: 'first:BTCUSDT', shortKey: 'second:BTCUSDT' }] };
  assert.deepEqual(service.actions.metrics, ['POST']);
  assert.equal(service.handle('metrics', 'POST', input).legs['first:BTCUSDT'].status, 'pending');
  await until(() => reads === 2 && service.handle('metrics', 'POST', input).legs['first:BTCUSDT'].status === 'ready');
  const report = service.handle('metrics', 'POST', input);
  for (let index = 0; index < 10; index++) service.handle('metrics', 'POST', input);
  await delay(10); assert.equal(reads, 2); assert.equal(report.legs['first:BTCUSDT'].volume24h.value, 0);
  assert.ok(savedMetrics.some(entry => entry.value.status === 'ready')); assert.equal(savedHistory.length, 0);
  assert.ok(service.snapshot().quotes.every(quote => quote.bidAskAt === now));
  assert.equal(service.handle('diagnostics', 'GET').marketMetrics.cached, 2);
});

test('lightweight overview counts unblocked bases and live price venues without renewing source times', async t => {
  let now = 1000, discoveries = 0;
  const markets = exchange => [
    update({ exchange }), update({ exchange, symbol: 'BTCUSD', quoteCurrency: 'USD' }),
    update({ exchange, symbol: 'ETHUSDT', base: 'ETH' }), update({ exchange, symbol: 'HIDDENUSDT', base: 'HIDDEN' }),
  ];
  const { service, sockets } = setup({ clock: () => now,
    exchanges: [{ id: 'test', name: 'Test', kind: 'cex' }, { id: 'second', name: 'Second', kind: 'dex' }],
    discover: async exchange => { discoveries++; return markets(exchange); },
    subscriptions: exchange => [{ url: `wss://example.invalid/${exchange}`, subscribe: [] }],
    crossexOptions: { store: { get: () => ({ revision: 0, config: { requireSpotTransfer: false, blockedBases: ['HIDDEN'] } }) } },
  });
  t.after(() => service.stop());
  const empty = service.handle('summary', 'GET');
  assert.equal(discoveries, 0, 'Overview reads must not start market discovery');
  assert.equal(empty.status, 'connecting'); assert.equal(empty.quoteUpdatedAt, null);
  assert.equal(Object.hasOwn(empty, 'quotes'), false); assert.equal(Object.hasOwn(empty, 'exchanges'), false);
  service.start(); await until(() => sockets.length === 2);
  for (const socket of sockets) socket.open();
  const first = sockets.find(socket => socket.url.endsWith('/test'));
  const second = sockets.find(socket => socket.url.endsWith('/second'));
  first.message(markets('test'));
  second.message([update({ exchange: 'second', bid: undefined, ask: undefined, mark: 102 })]);
  const summary = service.handle('summary', 'GET'), snapshot = service.snapshot();
  assert.equal(summary.schemaVersion, 1); assert.equal(summary.monitorId, 'perpetual');
  assert.equal(summary.staleAfterMs, snapshot.staleAfterMs); assert.equal(summary.status, snapshot.status);
  assert.equal(summary.baseCount, 2, 'Coverage deduplicates bases and removes saved blocked bases');
  assert.equal(summary.quoteCount, 5, 'The existing all-contract count keeps its meaning');
  assert.equal(summary.onlineExchangeCount, snapshot.exchanges.filter(exchange => exchange.status === 'live').length);
  assert.equal(summary.onlineExchangeCount, 2, 'A fresh mark-only venue remains online, like the detail');
  assert.equal(summary.liveExchangeCount, 1, 'The host summary keeps its book-only live count');
  assert.equal(summary.state, 'partial'); assert.match(summary.message, /second/);
  assert.equal(summary.quoteUpdatedAt, 1000); assert.equal(summary.updatedAt, 1000);
  const reads = discoveries;
  for (let i = 0; i < 3; i++) assert.deepEqual(service.handle('summary', 'GET'), summary);
  assert.equal(discoveries, reads, 'Repeated overviews read resident caches only');
  assert.equal(service.metrics().clients, 0, 'Overview reads never subscribe to the full stream');

  now = 32_000;
  for (const [exchange, socket] of [['test', first], ['second', second]]) socket.message([update({ exchange, bid: undefined, ask: undefined, fundingRate: 0.001, sourceTime: now })]);
  const retained = service.handle('summary', 'GET');
  assert.equal(retained.updatedAt, now, 'The pre-existing host timestamp remains the oldest venue message time');
  assert.equal(retained.quoteUpdatedAt, 1000, 'Funding-only updates must not renew the card price timestamp');
  assert.equal(retained.status, 'snapshot'); assert.equal(retained.onlineExchangeCount, 0);
  assert.equal(retained.baseCount, 2, 'Stale prices retain their coverage counts');
  now = 33_000; first.message([update({ sourceTime: now })]);
  const recovered = service.handle('summary', 'GET');
  assert.equal(recovered.status, 'partial'); assert.equal(recovered.quoteUpdatedAt, now);
  assert.equal(recovered.onlineExchangeCount, 1); assert.match(recovered.message, /second/);
});

test('official categories reach restored snapshots while CrossEx-specific enrichment stays isolated', async t => {
  let now = 1100;
  let metadata = { assetClass: 'crypto', identitySource: 'symbolType=', identityVerified: true, collateralCurrency: 'USDT' };
  const previous = mergePerpetualQuote(null, update({ exchange: 'binance' }), 1000);
  const { service, sockets } = setup({ clock: () => now, discoveryIntervalMs: 20,
    exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }],
    discover: async () => [{ ...update({ exchange: 'binance', multiplier: 1 }), ...metadata }],
    store: { load: () => [previous], prune() {}, save() {}, close() {} },
  });
  assert.deepEqual(service.handle('opportunities', 'GET').quotes, [], 'Restored cache alone has no current directory evidence');
  t.after(() => service.stop()); service.start();
  await until(() => sockets.length === 1);
  const current = service.handle('opportunities', 'GET').quotes[0];
  assert.equal(current.identityVerified, true); assert.equal(current.assetClass, 'crypto');
  assert.equal(current.collateralCurrency, 'USDT'); assert.equal(current.bidAskAt, 1000); assert.equal(current.receivedAt, 1000);
  const retained = service.snapshot().quotes[0];
  assert.equal(retained.collateralCurrency, undefined); assert.equal(retained.identityVerified, true);
  assert.equal(retained.assetClass, 'crypto'); assert.equal(retained.identitySource, 'symbolType=');
  now = 3000; metadata = { ...metadata, identityVerified: false };
  await until(() => service.handle('opportunities', 'GET').quotes.length === 0);
  assert.deepEqual(service.snapshot().quotes[0], { ...retained, identityVerified: false }); assert.equal(sockets.length, 1);
});

test('directory fingerprints join public HTTP quotes and streamed metadata to both history services without CrossEx enrichment', async t => {
  const observedAt = Date.UTC(2026, 9, 11, 12);
  let now = observedAt;
  const rows = [update({ exchange: 'binance', sourceTime: observedAt }), update({ exchange: 'lighter', symbol: 'BTC', quoteCurrency: 'USDC', sourceTime: observedAt })];
  let markets = [{ ...rows[0], collateralCurrency: 'USDT' }, { ...rows[1], marketId: 1 }];
  const { service, sockets } = setup({ clock: () => now, discoveryIntervalMs: 20,
    exchanges: rows.map(row => ({ id: row.exchange, name: row.exchange, kind: 'cex' })),
    discover: async exchange => markets.filter(market => market.exchange === exchange),
    subscriptions: (exchange, discovered) => [{ url: `wss://example.invalid/${exchange}`, subscribe: [], markets: discovered }],
    fundingHistoryOptions: { reader: async (_market, range) => [{ time: range.to, rate: 0.0001 }], hostSpacingMs: 0 },
    priceHistoryOptions: { reader: async (_market, range) => [{ time: range.to, close: 100 }], hostSpacingMs: 0 },
  });
  const server = createServer(createHandler({ services: new Map([['perpetual', service]]), username: 'test', password: 'test-password', nextHandler: (_request, response) => { response.writeHead(404); response.end(); } }));
  t.after(async () => { await service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  service.start(); await until(() => sockets.length === 2);
  for (const row of rows) { const socket = sockets.find(socket => socket.url.endsWith(`/${row.exchange}`)); socket.open(); socket.message([row]); }
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/`;
  const headers = { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}`, 'Content-Type': 'application/json' };
  const httpRead = async (action, body) => {
    const response = await fetch(baseUrl + action, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  const snapshot = await httpRead('quote'), baseline = new Map(snapshot.quotes.map(quote => [`${quote.exchange}:${quote.symbol}`, quote]));
  for (const market of markets) {
    const publicQuote = baseline.get(`${market.exchange}:${market.symbol}`);
    assert.equal(publicQuote.historyIdentity, perpetualPriceIdentity(market));
    assert.equal(publicQuote.collateralCurrency, undefined); assert.equal(publicQuote.marketId, undefined);
    assert.notEqual(publicQuote.historyIdentity, perpetualPriceIdentity(publicQuote), 'The public quote intentionally omits catalog-only identity fields');
  }
  const pair = { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'lighter:BTC' };
  const funding = await httpRead('funding-history', { pairs: [pair] }), price = await httpRead('price-history', { pair, days: 7 });
  for (const [key, quote] of baseline) {
    assert.equal(funding.legs[key].identity, quote.historyIdentity);
    assert.equal(price.legs[key].identity, quote.historyIdentity);
  }
  await until(() => Object.values(service.handle('funding-history', 'POST', { pairs: [pair] }).legs).every(leg => leg.records.length)
    && Object.values(service.handle('price-history', 'POST', { pair, days: 7 }).legs).every(leg => leg.points.length));
  const response = Object.assign(new EventEmitter(), {
    packets: [], writableLength: 0, writableNeedDrain: false, destroyed: false, writableEnded: false,
    writeHead() {}, write(message) { this.packets.push(JSON.parse(message.split('data: ')[1].trim())); },
    end() { this.writableEnded = true; this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
  });
  service.stream({ headers: {} }, response);
  assert.equal(response.packets[0].quotes.find(quote => quote.exchange === 'lighter').historyIdentity, baseline.get(pair.shortKey).historyIdentity);

  now += 1000; markets = [markets[0], { ...markets[1], marketId: 2 }];
  const identity = perpetualPriceIdentity(markets[1]);
  await until(() => response.packets.some(packet => packet.patches?.some(([key, patch]) => key === pair.shortKey && patch.historyIdentity === identity)));
  const patch = response.packets.flatMap(packet => packet.patches ?? []).find(([key, patch]) => key === pair.shortKey && patch.historyIdentity === identity)[1];
  assert.deepEqual(patch, { historyIdentity: identity, receivedAt: observedAt });
  const changed = service.snapshot().quotes.find(quote => quote.exchange === 'lighter');
  for (const field of ['bid', 'ask', 'bidAskAt', 'receivedAt', 'sourceTime']) assert.equal(changed[field], baseline.get(pair.shortKey)[field]);
  assert.equal(changed.marketId, undefined); assert.equal(changed.collateralCurrency, undefined);
  assert.equal(createPerpetualDelta(service.snapshot(), baseline).updates.find(quote => quote.exchange === 'lighter').historyIdentity, identity);
  assert.equal(service.handle('funding-history', 'POST', { pairs: [pair] }).legs[pair.shortKey].identity, identity);
  assert.equal(service.handle('price-history', 'POST', { pair, days: 7 }).legs[pair.shortKey].identity, identity);
});

test('history fingerprints reject restored claims, absent markets and quote-directory identity mismatches', async t => {
  let now = 1000;
  const stored = { ...mergePerpetualQuote(null, update(), now), historyIdentity: perpetualPriceIdentity(update()) };
  const { service, sockets } = setup({ clock: () => now, store: { load: () => [stored], save() {}, prune() {}, close() {} } });
  t.after(() => service.stop());
  assert.equal(service.snapshot().quotes[0].historyIdentity, null, 'A persisted fingerprint does not establish a current directory');
  service.start(); await until(() => sockets.length === 1);
  assert.equal(service.snapshot().quotes[0].historyIdentity, perpetualPriceIdentity(update()));
  sockets[0].open();
  for (const mismatch of [{ base: 'OTHER' }, { quoteCurrency: 'USDC' }, { multiplier: 1000 }, { contractUnit: 'different unit' }, { symbol: 'UNKNOWN' }]) {
    now++;
    sockets[0].message([update({ ...mismatch, sourceTime: now, historyIdentity: stored.historyIdentity })]);
    const quote = service.snapshot().quotes.find(quote => quote.symbol === (mismatch.symbol ?? 'BTCUSDT'));
    assert.equal(quote.historyIdentity, null, `Unverified directory identity: ${JSON.stringify(mismatch)}`);
  }
  const previous = { ...service.snapshot().quotes[0], historyIdentity: stored.historyIdentity };
  const cleared = createPerpetualPatch({ quotes: [{ ...previous, historyIdentity: null }] }, new Map([['test:BTCUSDT', previous]])).patches[0][1];
  assert.deepEqual(cleared, { historyIdentity: null, receivedAt: previous.receivedAt });
});

test('official classification refreshes and clears without refreshing prices or changing comparison eligibility', async t => {
  let now = 1000, catalog = { assetClass: 'crypto', identitySource: 'official category=crypto', identityVerified: true };
  const { service, sockets, saved } = setup({ clock: () => now, discoveryIntervalMs: 20,
    discover: async () => [{ ...update(), ...catalog }],
  });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update({ comparable: false })]);
  const original = service.snapshot().quotes[0], baseline = new Map([['test:BTCUSDT', original]]);
  assert.equal(original.assetClass, 'crypto'); assert.equal(original.identityVerified, true);

  now = 32000; catalog = { assetClass: 'stock', identitySource: 'official category=stock', identityVerified: false };
  await until(() => service.snapshot().quotes[0].assetClass === 'stock');
  const reclassified = service.snapshot().quotes[0];
  assert.equal(reclassified.identitySource, catalog.identitySource); assert.equal(reclassified.identityVerified, false);
  for (const field of ['base', 'comparable', 'bid', 'ask', 'bidAskAt', 'receivedAt', 'sourceTime']) assert.equal(reclassified[field], original[field]);
  assert.equal(service.snapshot().exchanges[0].status, 'stale'); assert.equal(sockets.length, 1);
  assert.deepEqual(createPerpetualPatch(service.snapshot(), baseline).patches[0][1], { ...catalog, receivedAt: 1000 });
  await until(() => saved.some(quote => quote.assetClass === 'stock'));

  // Subscription parsers may retain old directory objects; the current directory wins.
  sockets[0].message([update({ sourceTime: now, assetClass: 'crypto', identitySource: 'old subscription', identityVerified: true })]);
  assert.equal(service.snapshot().quotes[0].assetClass, 'stock');
  assert.equal(service.snapshot().quotes[0].identitySource, catalog.identitySource);
  const latest = service.snapshot().quotes[0];
  catalog = {};
  await until(() => service.snapshot().quotes[0].assetClass === null);
  assert.equal(service.snapshot().quotes[0].identitySource, null); assert.equal(service.snapshot().quotes[0].identityVerified, null);
  assert.equal(service.snapshot().quotes[0].receivedAt, latest.receivedAt);
  assert.equal(service.snapshot().quotes[0].bidAskAt, latest.bidAskAt); assert.equal(sockets.length, 1);
});

test('discovered identity changes invalidate restored prices before the first new WS message', async t => {
  const previous = mergePerpetualQuote(null, update({ base: 'OLD-ASSET' }), 1000);
  const pruned = [];
  const { service, sockets } = setup({ clock: () => 1100, store: { load: () => [previous], prune: (_exchange, symbols) => pruned.push([...symbols]), close() {} } });
  t.after(() => service.stop());
  assert.equal(service.snapshot().quotes.length, 1);
  service.start(); await until(() => sockets.length === 1);
  assert.equal(service.snapshot().quotes.length, 0);
  assert.deepEqual(pruned, [[]]);
});

test('lifecycle discovery updates, persists and clears notices without reconnecting or freshening prices', async t => {
  let now = 1000, catalog = { delisting: false, delistingAt: null }, fail = false, attempts = 0;
  const { service, sockets, saved } = setup({ clock: () => now, discoveryIntervalMs: 20,
    discover: async () => { attempts++; if (fail) throw Error('offline'); return [{ ...update(), ...catalog }]; },
  });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update()]);
  const original = service.snapshot().quotes[0];
  const baseline = new Map([['test:BTCUSDT', original]]);
  now = 32000; catalog = { delisting: true, delistingAt: 200000 };
  await until(() => service.snapshot().quotes[0].delisting === true);
  const announced = service.snapshot().quotes[0];
  assert.equal(announced.delistingAt, 200000);
  assert.equal(announced.receivedAt, original.receivedAt);
  assert.equal(announced.bidAskAt, original.bidAskAt);
  assert.equal(service.snapshot().exchanges[0].status, 'stale');
  assert.equal(sockets.length, 1, 'A metadata-only refresh must keep the existing WS connection');
  const patch = createPerpetualPatch(service.snapshot(), baseline).patches[0][1];
  assert.equal(patch.delisting, true); assert.equal(patch.delistingAt, 200000);
  assert.equal(Object.hasOwn(patch, 'bidAskAt'), false);
  await until(() => saved.some(quote => quote.delisting && quote.delistingAt === 200000));

  // Price parsers from old subscriptions must not override newer catalog data.
  sockets[0].message([update({ sourceTime: now, delisting: false, delistingAt: null })]);
  assert.equal(service.snapshot().quotes[0].delisting, true);
  fail = true; const before = attempts;
  await until(() => attempts > before);
  assert.equal(service.snapshot().quotes[0].delistingAt, 200000, 'A failed directory read retains the last official notice');

  fail = false; catalog = { delisting: false, delistingAt: null };
  await until(() => service.snapshot().quotes[0].delisting === false);
  assert.equal(service.snapshot().quotes[0].delistingAt, null);
  assert.equal(sockets.length, 1);
  const cleared = createPerpetualPatch(service.snapshot(), baseline).patches[0][1];
  assert.equal(cleared.delisting, false); assert.equal(cleared.delistingAt, null);
});

test('catalog taker fees update per contract and clear independently without reconnecting or confirming old prices', async t => {
  let now = 1000, fail = false, attempts = 0;
  let catalog = { takerFeeRate: 0.0006, takerFeeAt: now, takerFeeSource: 'bitget-contract' };
  const { service, sockets, saved } = setup({ clock: () => now, discoveryIntervalMs: 20,
    discover: async () => {
      attempts++; if (fail) throw Error('offline');
      return [{ ...update(), ...catalog }, update({ symbol: 'ETHUSDT', base: 'ETH', takerFeeRate: 0, takerFeeAt: 1000, takerFeeSource: 'bitget-contract' }), update({ symbol: 'UNKNOWNUSDT', base: 'UNKNOWN' })];
    },
  });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update(), update({ symbol: 'ETHUSDT', base: 'ETH' }), update({ symbol: 'UNKNOWNUSDT', base: 'UNKNOWN' })]);
  const original = service.snapshot().quotes[0];
  assert.equal(original.takerFeeRate, 0.0006);
  assert.equal(service.snapshot().quotes[1].takerFeeRate, 0, 'An explicit zero is a real published fee');
  assert.equal(Object.hasOwn(service.snapshot().quotes[2], 'takerFeeRate'), false, 'Unrelated venues need no empty fee fields');
  const baseline = new Map([['test:BTCUSDT', original]]), deltaBaseline = new Map(baseline);

  now = 32000; catalog = { ...catalog, takerFeeRate: 0.0008, takerFeeAt: now };
  await until(() => service.snapshot().quotes[0].takerFeeRate === 0.0008);
  const changed = service.snapshot().quotes[0];
  assert.equal(changed.bidAskAt, original.bidAskAt); assert.equal(changed.receivedAt, original.receivedAt);
  assert.equal(changed.sourceTime, original.sourceTime);
  assert.equal(service.snapshot().exchanges[0].status, 'stale');
  assert.equal(sockets.length, 1);
  const patch = createPerpetualPatch(service.snapshot(), baseline).patches.find(([key]) => key === 'test:BTCUSDT')[1];
  assert.equal(patch.takerFeeRate, 0.0008); assert.equal(patch.takerFeeAt, now);
  assert.equal(Object.hasOwn(patch, 'bidAskAt'), false);
  assert.equal(createPerpetualDelta(service.snapshot(), deltaBaseline).updates.find(quote => quote.symbol === 'BTCUSDT').takerFeeRate, 0.0008);
  await until(() => saved.some(quote => quote.symbol === 'BTCUSDT' && quote.takerFeeRate === 0.0008));

  // Rechecking the same fee confirms only its own timestamp.
  now++; catalog = { ...catalog, takerFeeAt: now };
  await until(() => service.snapshot().quotes[0].takerFeeAt === now);
  const timePatch = createPerpetualPatch(service.snapshot(), baseline).patches.find(([key]) => key === 'test:BTCUSDT')[1];
  assert.deepEqual(timePatch, { takerFeeAt: now, receivedAt: 1000 });
  assert.equal(createPerpetualDelta(service.snapshot(), deltaBaseline).updates.find(quote => quote.symbol === 'BTCUSDT').takerFeeAt, now);
  assert.equal(sockets.length, 1);

  sockets[0].message([update({ sourceTime: now, takerFeeRate: 0.1, takerFeeAt: now + 1000 })]);
  assert.equal(service.snapshot().quotes[0].takerFeeRate, 0.0008, 'Old subscription contexts cannot override the current catalog');
  fail = true; const before = attempts;
  await until(() => attempts > before);
  assert.equal(service.snapshot().quotes[0].takerFeeAt, now, 'An unavailable directory cannot confirm a cached fee');

  fail = false; catalog = { takerFeeRate: null, takerFeeAt: null, takerFeeSource: 'bitget-contract' };
  await until(() => service.snapshot().quotes[0].takerFeeRate === null);
  const cleared = createPerpetualPatch(service.snapshot(), baseline).patches.find(([key]) => key === 'test:BTCUSDT')[1];
  assert.equal(cleared.takerFeeRate, null); assert.equal(cleared.takerFeeAt, null);
  assert.equal(sockets.length, 1);

  catalog = {};
  await until(() => service.snapshot().quotes[0].takerFeeSource === null);
  assert.equal(service.snapshot().quotes[0].takerFeeRate, null);
  assert.equal(sockets.length, 1, 'Removing all fee fields is also a metadata-only change');
});

test('slow SSE clients resynchronize with a full frame after missing a delta', async t => {
  let now = 1000;
  const { service, sockets } = setup({ clock: () => now });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update()]);
  const response = Object.assign(new EventEmitter(), {
    packets: [], writableLength: 0, writableNeedDrain: false, destroyed: false, writableEnded: false,
    writeHead() {}, write(message) { this.packets.push(JSON.parse(message.split('data: ')[1].trim())); },
    end() { this.writableEnded = true; this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
  });
  service.stream({ headers: {} }, response);
  assert.equal(response.packets[0].quotes[0].bid, 100);
  response.writableNeedDrain = true;
  now = 1100; sockets[0].message([update({ bid: 100.5, sourceTime: now })]);
  const before = service.metrics().frames; await until(() => service.metrics().frames > before);
  assert.equal(response.packets.length, 1);
  response.writableNeedDrain = false;
  await until(() => response.packets.length > 1);
  assert.equal(response.packets[1].type, undefined);
  assert.equal(response.packets[1].quotes[0].bid, 100.5);
  assert.ok(response.packets[1].sequence > response.packets[0].sequence);
  assert.equal(response.packets[1].streamId, response.packets[0].streamId);
  service.closeStreams(); assert.equal(service.metrics().clients, 0);
});

test('new SSE clients align with the shared baseline after a price reverses before broadcast', async t => {
  let now = 1000;
  const { service, sockets } = setup({ clock: () => now, broadcastIntervalMs: 50 });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update()]);
  const reader = () => Object.assign(new EventEmitter(), {
    packets: [], writableLength: 0, writableNeedDrain: false, destroyed: false, writableEnded: false,
    writeHead() {}, write(message) { this.packets.push(JSON.parse(message.split('data: ')[1].trim())); },
    end() { this.writableEnded = true; this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
  });
  const existing = reader(), joining = reader();
  service.stream({ headers: {} }, existing);
  assert.equal(existing.packets[0].quotes[0].bid, 100);

  // All three operations happen in one event-loop turn, between broadcasts.
  now = 1100; sockets[0].message([update({ bid: 101, ask: 102, sourceTime: now })]);
  assert.equal(service.snapshot().quotes[0].bid, 101);
  service.stream({ headers: {} }, joining);
  assert.equal(joining.packets[0].quotes[0].bid, 100, 'New reader starts with the already-published baseline');
  assert.equal(joining.packets[0].quotes[0].bidAt, 1000, 'Retain the original quote time');
  now = 1200; sockets[0].message([update({ sourceTime: now })]);
  await until(() => existing.packets.length > 1 && joining.packets.length > 1);
  assert.equal(existing.packets[1].type, 'patch', 'First client needs no redundant full snapshot');
  assert.equal(joining.packets[1].type, 'patch');
  assert.equal(joining.packets[1].baseSequence, joining.packets[0].sequence);
  const changes = joining.packets[1].patches.find(([key]) => key === 'test:BTCUSDT')?.[1] ?? {};
  assert.equal({ ...joining.packets[0].quotes[0], ...changes }.bid, 100);
  assert.equal(joining.packets[1].sequence, existing.packets[1].sequence);
  assert.equal(service.metrics().fullFrames, 2, 'Only one full snapshot per reader');

  const before = joining.packets.length, baseline = joining.packets.at(-1).sequence;
  now = 1300; sockets[0].message([update({ bid: 100.5, sourceTime: now })]);
  await until(() => joining.packets.length > before);
  const patch = joining.packets[before];
  assert.equal(patch.type, 'patch'); assert.equal(patch.baseSequence, baseline);
  assert.equal(patch.patches.find(([key]) => key === 'test:BTCUSDT')[1].bid, 100.5);
});

test('Lighter confirmation rounds finish every three seconds within the client message budget and stop cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1_789_820_000_000;
  const startedAt = now, sent = [];
  const { service, sockets } = setup({ clock: () => now,
    exchanges: [{ id: 'lighter', name: 'Lighter', kind: 'dex' }],
    discover: async () => [{ exchange: 'lighter', symbol: 'BTC', base: 'BTC', quoteCurrency: 'USDC', multiplier: 1, marketId: 1 }],
    subscriptions: createSubscriptions, parse: parseMessage, control: getControlResponse,
    saveIntervalMs: 60_000, broadcastIntervalMs: 60_000,
  });
  t.after(() => service.stop()); service.start();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(0); assert.equal(sockets.length, 1);
  const socket = sockets[0];
  socket.send = data => {
    const message = JSON.parse(data); sent.push({ ...message, at: now - startedAt });
    if (message.type === 'subscribe') socket.message({ type: 'subscribed/market_stats', channel: 'market_stats:all', timestamp: now,
      market_stats: { 1: { market_id: 1, best_bid_price: '100', best_ask_price: '101' } } });
  };
  socket.open(); t.mock.timers.tick(0);
  for (let elapsed = 100; elapsed <= 60_000; elapsed += 100) { now += 100; t.mock.timers.tick(100); }
  const rounds = sent.filter(message => message.channel === 'market_stats/all').slice(1);
  assert.equal(rounds.length, 40, 'One full-market confirmation uses two messages, twenty times per minute');
  for (let index = 0; index < 20; index++) {
    assert.deepEqual(rounds.slice(index * 2, index * 2 + 2), [
      { type: 'unsubscribe', channel: 'market_stats/all', at: 800 + index * 3_000 },
      { type: 'subscribe', channel: 'market_stats/all', at: 1_200 + index * 3_000 },
    ]);
  }
  assert.equal(sent.filter(message => message.type === 'ping').length, 2);
  assert.ok(sent.length < 200, 'Confirmation plus initial subscription and client heartbeats fit the 200/minute IP limit');
  assert.equal(service.snapshot().quotes[0].bidAskAt, startedAt + 58_200);
  assert.equal(sockets.length, 1, 'Repeated unchanged price confirmations keep the collector connected');
  await service.stop();
  const count = sent.length; now += 60_000; t.mock.timers.tick(60_000);
  assert.equal(sent.length, count); assert.equal(sockets.length, 1);
});

test('WS snapshot requests are paced and REST confirmation cannot continue after connection disposal', async t => {
  let requests = 0, signal, resolveSnapshot;
  const { service, sockets } = setup({ subscriptions: (_id, markets) => [{
    url: 'wss://example.invalid', markets, poll: { messages: [{ request: 1 }, { request: 2 }], intervalMs: 20, sendIntervalMs: 5 },
    snapshot: options => { requests++; signal = options.signal; return new Promise(resolve => { resolveSnapshot = resolve; }); },
  }], saveIntervalMs: 10_000 });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1); sockets[0].open();
  await delay(130);
  assert.deepEqual(sockets[0].sent.slice(0, 2).map(JSON.parse), [{ request: 1 }, { request: 2 }]);
  await until(() => requests === 1);
  await service.stop();
  assert.equal(signal.aborted, true);
  const sent = sockets[0].sent.length;
  resolveSnapshot([update()]); await delay(30);
  assert.equal(service.snapshot().quotes.length, 0);
  assert.equal(sockets[0].sent.length, sent);
  assert.equal(requests, 1);
});

test('optional book confirmations skip fresh quotes, share a host budget and back off 429 without disconnecting BBO', async t => {
  let now = 100_000;
  const info = symbol => ({ method: 'post', id: symbol, request: { type: 'info', payload: { type: 'l2Book', coin: symbol } } });
  const { service, sockets } = setup({ clock: () => now, saveIntervalMs: 10_000,
    subscriptions: (_id, markets) => [0, 1].map(() => ({
      url: 'wss://shared.example.invalid', markets, sendIntervalMs: 1,
      poll: { messages: [info('BTCUSDT'), info('MISSING')], intervalMs: 10, sendIntervalMs: 1, staleBookAfterMs: 15_000, maxPerMinute: 60 },
    })),
  });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 2);
  for (const socket of sockets) { socket.open(); socket.message([update({ sourceTime: now })]); }
  await until(() => sockets.some(socket => socket.sent.length));
  const sent = sockets.flatMap(socket => socket.sent).map(JSON.parse);
  assert.equal(sent.length, 1, 'Only one host-wide request is allowed in a one-second slot');
  assert.equal(sent[0].request.payload.coin, 'MISSING', 'Fresh BBO never needs a redundant info request');
  sockets[0].message({ channel: 'post', data: { response: { type: 'error', payload: '429 Too Many Requests' } } });
  now += 1000;
  for (const socket of sockets) socket.message([update({ sourceTime: now, bid: 100.5 })]);
  await delay(35);
  assert.equal(sockets.length, 2); assert.ok(sockets.every(socket => socket.readyState === 1));
  assert.equal(sockets.reduce((total, socket) => total + socket.sent.length, 0), 1);
  assert.equal(service.snapshot().quotes[0].bid, 100.5, 'Main BBO remains active during optional request backoff');
  assert.match(service.metrics().venues[0].lastProtocolError, /429/);
  assert.ok(service.metrics().auxiliary[0].retryAt > now);
});

test('healthy main WS cannot hide a failing whole-market REST confirmation', async t => {
  const { service, sockets } = setup({ subscriptions: (_id, markets) => [{ url: 'wss://example.invalid', markets,
    snapshot: async () => { throw Error('temporarily unreachable'); }, snapshotIntervalMs: 10_000,
  }] });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1); sockets[0].open();
  await until(() => /快照/.test(service.snapshot().exchanges[0].error ?? ''));
  sockets[0].message([update({ sourceTime: Date.now() })]);
  assert.equal(service.snapshot().exchanges[0].status, 'live');
  assert.match(service.snapshot().exchanges[0].error, /盘口补充快照/);
});

test('collector runs without readers, rejects bad clocks, persists updates and reconnects with fresh context', async t => {
  let now = 1000;
  const { service, sockets, saved } = setup({ clock: () => now });
  t.after(() => service.stop()); service.start();
  await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update()]);
  await until(() => saved.length === 1);
  assert.equal(service.snapshot().status, 'live');
  assert.equal(service.snapshot().quotes[0].bid, 100);
  now = 32000;
  sockets[0].message([update({ bid: undefined, ask: undefined, fundingRate: 0, sourceTime: now })]);
  assert.equal(service.snapshot().status, 'snapshot');
  sockets[0].close();
  await until(() => sockets.length === 2);
  sockets[1].open(); sockets[1].message([update({ sourceTime: now })]);
  assert.equal(service.snapshot().status, 'live');
  await service.stop();
  const count = sockets.length; await delay(30); assert.equal(sockets.length, count);
});

test('empty and crossed BBOs do not count as fresh market coverage', async t => {
  const { service, sockets } = setup({ clock: () => 1000 });
  t.after(() => service.stop()); service.start();
  await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update({ bid: null, ask: null })]);
  assert.equal(service.snapshot().exchanges[0].quoteCount, 0);
  sockets[0].message([update({ bid: 103, ask: 101 })]);
  assert.equal(service.snapshot().exchanges[0].quoteCount, 0);
});

test('restored quotes from a future server clock never count as live coverage', async t => {
  const future = mergePerpetualQuote(null, update({ sourceTime: 100_000 }), 100_000);
  const { service, sockets } = setup({ clock: () => 1000, store: { load: () => [future], prune() {}, close() {} } });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1); sockets[0].open();
  const view = service.snapshot().exchanges[0];
  assert.equal(view.quoteCount, 0); assert.equal(view.freshBookCount, 0); assert.equal(view.missingBookCount, 1);
  assert.equal(view.status, 'stale');
});

test('failed delisting cleanup retries even without new quote writes', async t => {
  let pruning = 0;
  const { service, sockets } = setup({ saveIntervalMs: 50, store: {
    load: () => [mergePerpetualQuote(null, update({ symbol: 'OLD' }), 1000)], save() {}, close() {},
    prune(_exchange, symbols) { pruning++; assert.equal(symbols.has('OLD'), false); if (pruning === 1) throw Error('temporarily locked'); },
  } });
  t.after(() => service.stop()); service.start();
  await until(() => sockets.length === 1);
  assert.equal(service.healthy(), false);
  assert.equal(service.snapshot().quotes.length, 0);
  await until(() => pruning === 2);
  assert.equal(service.healthy(), true);
});

test('SSE uses existing authentication, validates methods and closes before HTTP shutdown drains', async t => {
  const { service } = setup();
  const services = new Map([['perpetual', service]]);
  const server = createServer(createHandler({ services, username: 'test', password: 'test-password', nextHandler: (_request, response) => { response.writeHead(404); response.end(); } }));
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  t.after(async () => { service.closeStreams(); await service.stop(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); });
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/stream`;
  const headers = { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}` };
  const summaryUrl = url.replace(/stream$/, 'summary');
  assert.equal((await fetch(summaryUrl)).status, 401);
  assert.equal((await fetch(summaryUrl, { headers, method: 'POST' })).status, 405);
  const overview = await fetch(summaryUrl, { headers });
  assert.equal(overview.status, 200);
  const summary = await overview.json();
  assert.equal(summary.monitorId, 'perpetual'); assert.equal(summary.status, 'connecting');
  assert.equal(Object.hasOwn(summary, 'quotes'), false); assert.equal(service.metrics().clients, 0);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers, method: 'POST' })).status, 405);
  const response = await fetch(url, { headers });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"monitorId":"perpetual"/);
  service.closeStreams();
  assert.equal((await reader.read()).done, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { calculatePerpetualPaperPnl, perpetualPaperIdentity, PERPETUAL_PAPER_LIMITS as limits } from '../lib/perpetual-paper.ts';
import { createPerpetualPaperService, initialPerpetualPaperState, evaluatePerpetualPaperPosition } from '../server/perpetual-paper-service.mjs';
import { openPerpetualPaperStore, validatePerpetualPaperState } from '../server/perpetual-paper-store.mjs';
import { createHandler } from '../server/http.mjs';

const NOW = 1_800_000_000_000;
const entry = { quantity: 10, entryLongPrice: 100, entryShortPrice: 102, entryFeePaid: 1, settledFunding: 2, capital: 400 };
function quotes(now = NOW, patch = {}) { return new Map([
  ['binance:BTCUSDT', { exchange: 'binance', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', collateralCurrency: 'USDT', comparable: true, bid: 100, ask: 100.01, receivedAt: now, bidAskAt: now, nextFundingAt: NOW + 3_600_000 }],
  ['gate:BTC_USDT', { exchange: 'gate', symbol: 'BTC_USDT', base: 'BTC', quoteCurrency: 'USDT', collateralCurrency: 'USDT', comparable: true, bid: 101, ask: 101.01, receivedAt: now, bidAskAt: now, nextFundingAt: NOW + 3_600_000, ...patch }],
]); }
function draft(patch = {}) {
  const values = quotes();
  return { ...entry, mode: 'paper', base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'gate:BTC_USDT',
    identity: perpetualPaperIdentity(...values.values()), openedAt: NOW, targetNetProfit: 5, maxHoldingHours: 1, ...patch };
}
function fixture(options = {}) {
  let now = NOW, values = quotes(), saved = options.state ?? initialPerpetualPaperState(), writes = 0, fail = false, live = true;
  const store = { get: () => structuredClone(saved), save: async state => { writes++; if (fail) throw new Error('disk'); saved = validatePerpetualPaperState(state); } };
  const service = createPerpetualPaperService({ store, getQuote: key => values.get(key), clock: () => now, isVenueLive: () => live });
  service.start();
  return { service, saved: () => structuredClone(saved), writes: () => writes, setFail: value => { fail = value; }, setLive: value => { live = value; },
    setTime: value => { now = value; }, setQuotes: value => { values = value; },
    async create(patch = {}) { return service.update({ revision: service.view().revision, action: 'create', position: draft(patch) }); },
    async command(action, fields = {}) { return service.update({ revision: service.view().revision, action, id: service.view().positions[0]?.id, ...fields }); },
    async tick(minute, patch = {}) { now = NOW + minute * 60_000; values = quotes(now, patch); await service.check(); },
  };
}

test('paper PnL uses sell-long buy-short direction, actual exit notionals and recorded fees/funding', () => {
  const pnl = calculatePerpetualPaperPnl(entry, { exitLongPrice: 101, exitShortPrice: 101.5, closeFeePaid: 1.1 });
  assert.equal(pnl.longProfit, 10); assert.equal(pnl.shortProfit, 5);
  assert.equal(pnl.netProfit, 14.9); assert.equal(pnl.returnOnLongNotionalPercent, 1.49);
  assert.ok(Math.abs(pnl.returnOnCapitalPercent - 3.725) < 1e-12); assert.equal(pnl.totalEntryNotional, 2020);
  assert.equal(calculatePerpetualPaperPnl({ ...entry, settledFunding: -5, capital: null }, { exitLongPrice: 101, exitShortPrice: 101.5, closeFeePaid: 0 }).netProfit, 9);
  for (const patch of [{ quantity: 0 }, { entryLongPrice: NaN }, { entryFeePaid: -1 }, { capital: 0 }, { settledFunding: Infinity }]) assert.equal(calculatePerpetualPaperPnl({ ...entry, ...patch }, { exitLongPrice: 100, exitShortPrice: 100, closeFeePaid: 0 }), null);
});

test('paper creation restricts known same-identity USDT contracts and supports explicit manual mode', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  for (const patch of [{ longKey: 'unknown:BTCUSDT' }, { identity: 'old' }, { base: 'ETH' }, { shortKey: 'binance:BTCUSDT' }, { mode: 'exchange-confirmed' }, { quantity: 0 }, { entryFeePaid: -1 }, { settledFunding: NaN }, { openedAt: NOW + 1 }, { takerOverrides: { fake: 0 } }]) await assert.rejects(f.create(patch));
  for (const patch of [{ quoteCurrency: 'USDC' }, { collateralCurrency: 'USDC' }, { multiplier: 1000 }, { comparable: false }, { delistingAt: NOW }]) {
    f.setQuotes(quotes(NOW, patch)); await assert.rejects(f.create());
  }
  f.setQuotes(quotes());
  const view = await f.create({ mode: 'manual' });
  assert.equal(view.positions[0].mode, 'manual'); assert.equal(view.positions[0].currentObservation.valid, true);
  assert.equal(view.positions[0].fundingUpdatedAt, NOW); assert.equal(view.positions[0].nextFundingAt, NOW + 3_600_000);
  assert.equal(view.positions[0].targetReachedAt, NOW);
  await assert.rejects(f.service.update({ revision: 0, action: 'create', position: draft() }), error => error.status === 409);
  assert.equal(f.writes(), 1);
});

test('paper observations never guess funding and invalidate stale, skewed, offline or changed contracts', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.create();
  const position = f.service.view().positions[0];
  for (const patch of [{ bidAskAt: NOW - 30_001 }, { bidAskAt: NOW - 5_001 }, { ask: 99 }, { bid: null }, { multiplier: 100 }, { delistingAt: NOW }]) {
    const values = quotes(NOW, patch);
    assert.equal(evaluatePerpetualPaperPosition(position, key => values.get(key), NOW).valid, false);
  }
  f.setLive(false); assert.equal(f.service.view().positions[0].currentObservation.valid, false);
  f.setLive(true); await f.tick(61, { nextFundingAt: NOW + 8 * 3_600_000 });
  let view = f.service.view(), current = view.positions[0];
  assert.equal(current.currentObservation.fundingNeedsReview, true); assert.equal(current.settledFunding, 2);
  assert.equal(current.timedOutAt, NOW + 61 * 60_000);
  const freshSchedules = quotes(NOW + 61 * 60_000); for (const quote of freshSchedules.values()) quote.nextFundingAt = NOW + 8 * 3_600_000;
  f.setQuotes(freshSchedules);
  await f.command('update', { changes: { settledFunding: 2 } });
  current = f.service.view().positions[0];
  assert.equal(current.currentObservation.fundingNeedsReview, false); assert.equal(current.fundingUpdatedAt, NOW + 61 * 60_000);
  assert.equal(current.nextFundingAt, NOW + 8 * 3_600_000);
});

test('unknown funding schedules are explicit and later discovery never erases an unconfirmed settlement', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const unknown = quotes(); for (const quote of unknown.values()) quote.nextFundingAt = null;
  f.setQuotes(unknown); await f.create();
  assert.equal(f.service.view().positions[0].currentObservation.fundingNeedsReview, true);
  assert.match(f.service.view().positions[0].currentObservation.reason, /未知/);
  await f.tick(1);
  assert.equal(f.service.view().positions[0].nextFundingAt, NOW + 3_600_000);
  await f.tick(61, { nextFundingAt: NOW + 8 * 3_600_000 });
  assert.equal(f.service.view().positions[0].nextFundingAt, NOW + 3_600_000);
  assert.equal(f.service.view().positions[0].currentObservation.fundingNeedsReview, true);
});

test('one known funding schedule never conceals the missing leg or an earlier revised settlement', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  f.setQuotes(quotes(NOW, { nextFundingAt: null })); await f.create();
  assert.equal(f.service.view().positions[0].currentObservation.fundingNeedsReview, true);
  await f.tick(1, { nextFundingAt: NOW + 30 * 60_000 });
  assert.equal(f.service.view().positions[0].nextFundingAt, NOW + 30 * 60_000);
  await f.tick(31);
  assert.equal(f.service.view().positions[0].nextFundingAt, NOW + 30 * 60_000);
  assert.equal(f.service.view().positions[0].currentObservation.fundingNeedsReview, true);
});

test('paper limits match exit-calculator limits, with zero account taker fees kept valid', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  for (const patch of [{ quantity: 1e18 + 256 }, { quantity: 100_001 }, { entryFeePaid: 1e9 + 1 }, { settledFunding: 1e9 + 1 }, { capital: 1e9 + 1 }]) await assert.rejects(f.create(patch));
  await f.create({ takerOverrides: { binance: 0, gate: 0 } });
  assert.equal(f.service.view().positions[0].currentObservation.pnl.closeFeePaid, 0);
  const state = f.saved(); state.positions[0].quantity = 100_001;
  assert.throws(() => validatePerpetualPaperState(state));
});

test('minute state persistence is independent of API reads and second ticks, with explicit outage gaps', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.create(); await f.tick(0);
  const baseline = f.writes();
  for (let second = 1; second < 60; second++) { f.setTime(NOW + second * 1000); f.service.view(); await f.service.check(); }
  assert.equal(f.writes(), baseline);
  await f.tick(1, { bidAskAt: NOW });
  let position = f.service.view().positions[0];
  assert.equal(position.lastObservation.valid, false);
  assert.equal(position.samples[0][1], null, 'Missing minute data is not replaced with a confident 5-minute value');
  const worst = position.worstObservedNetProfit;
  await f.tick(15);
  position = f.service.view().positions[0];
  assert.equal(position.samples.some(([at, value]) => at > NOW && at < NOW + 15 * 60_000 && value === null), true);
  assert.equal(position.worstObservedNetProfit, worst, 'A gap does not invent a worse or better observation');
  assert.equal(position.observations, 4, 'No backfill of skipped minutes');
});

test('paper state remains bounded through long observation and has no new API-side sampling', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.create();
  for (let minute = 0; minute <= 1600; minute += 5) await f.tick(minute);
  let position = f.service.view().positions[0];
  assert.equal(position.samples.length, 288); assert.equal(position.observations, 322);
  const before = f.writes();
  for (let read = 0; read < 20; read++) f.service.view();
  assert.equal(f.writes(), before);
  await f.command('close', { close: { kind: 'stop' } });
  position = f.service.view().positions[0];
  assert.equal(position.close.pnl, null); assert.equal(position.status, 'stopped');
  assert.ok(position.samples.length <= limits.closedSamples);
});

test('20 active cap, 100 closed cap and 30-day closed expiry never remove active records', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  for (let index = 0; index < 20; index++) await f.create();
  await assert.rejects(f.create(), /20/);
  await assert.rejects(f.command('delete'), /结束/);
  let active = f.service.view().positions[0];
  await f.command('close', { id: active.id, close: { kind: 'realized', exitLongPrice: 101, exitShortPrice: 101.5, closeFeePaid: 1.1, settledFunding: 2 } });
  const closed = f.service.view().positions.find(item => item.id === active.id);
  assert.equal(closed.close.pnl.netProfit, 14.9); assert.equal(closed.status, 'closed');
  await f.tick(31 * 24 * 60);
  assert.equal(f.service.view().positions.length, 19); assert.ok(f.service.view().positions.every(item => item.status === 'active'));
  const state = f.saved();
  state.positions = [...state.positions, ...Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(closed), id: `closed-${index}`, close: { ...closed.close, closedAt: NOW + 31 * 86_400_000 } }))];
  const g = fixture({ state }); t.after(() => g.service.stop()); g.setTime(NOW + 31 * 86_400_000);
  active = g.service.view().positions.find(item => item.status === 'active');
  await g.command('close', { id: active.id, close: { kind: 'stop' } });
  assert.equal(g.service.view().positions.filter(item => item.status !== 'active').length, 100);
});

test('failed atomic saves never publish unpersisted edits, and retry keeps optimistic revisions correct', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.create();
  const initial = f.service.view(); f.setFail(true);
  await assert.rejects(f.command('update', { changes: { settledFunding: 123 } }), error => error.status === 503);
  assert.equal(f.service.view().positions[0].settledFunding, 2); assert.equal(f.service.view().revision, initial.revision);
  assert.equal(f.service.healthy(), false); f.setFail(false);
  await f.command('update', { changes: { settledFunding: 123 } });
  assert.equal(f.service.view().positions[0].settledFunding, 123); assert.equal(f.service.healthy(), true);
  const simultaneous = await Promise.allSettled([1, 2].map(number => f.service.update({ revision: f.service.view().revision, action: 'update', id: initial.positions[0].id, changes: { note: String(number) } })));
  assert.equal(simultaneous.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(simultaneous.find(item => item.status === 'rejected').reason.status, 409);
});

test('lost registration responses retry idempotently across edits, closure and restart without bypassing input identity', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const request = { revision: 0, action: 'create', position: draft({ requestId: 'paper-http-compatibility-123' }) };
  const first = await f.service.update(request), id = first.positions[0].id;
  assert.equal((await f.service.update(request)).positions[0].id, id); assert.equal(f.writes(), 1);
  for (const change of [{ quantity: 11 }, { longKey: 'other:BTCUSDT' }, { identity: 'other' }, { openedAt: NOW - 1 }, { settledFunding: 3 }]) {
    await assert.rejects(f.service.update({ ...request, position: { ...request.position, ...change } }), error => error.status === 409);
  }
  await f.command('update', { changes: { settledFunding: 12, capital: 500 } });
  assert.equal((await f.service.update(request)).positions[0].settledFunding, 12, 'A retry does not replace newer manual edits');
  await f.command('close', { close: { kind: 'stop' } });
  assert.equal((await f.service.update(request)).positions[0].status, 'stopped', 'A closed record cannot be re-opened by retry');
  const g = fixture({ state: f.saved() }); t.after(() => g.service.stop());
  assert.equal((await g.service.update(request)).positions[0].id, id); assert.equal(g.writes(), 0);
  await assert.rejects(g.service.update({ revision: 0, action: 'create', position: draft({ requestId: 'new-request' }) }), error => error.status === 409);
  for (const token of ['', 'invalid token', 'x'.repeat(81)]) await assert.rejects(g.create({ requestId: token }));
  await g.command('delete');
  await g.create({ requestId: request.position.requestId });
  assert.notEqual(g.service.view().positions[0].id, id, 'Deleted registration ids are released within the bounded record lifecycle');
  const legacy = f.saved(); delete legacy.positions[0].requestId; delete legacy.positions[0].requestFingerprint;
  assert.equal(validatePerpetualPaperState(legacy).positions[0].requestId, undefined);
});

test('paper restart restores bounded state without inventing elapsed observations', async t => {
  const f = fixture(); await f.create(); await f.tick(5); await f.service.stop();
  const g = fixture({ state: f.saved() }); t.after(() => g.service.stop()); await g.tick(120);
  const position = g.service.view().positions[0];
  assert.equal(position.observations, 3); assert.ok(position.samples.some(([at, value]) => at > NOW + 5 * 60_000 && at < NOW + 120 * 60_000 && value === null));
});

test('atomic paper store round-trips, guards byte caps and rejects corruption without discarding entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-paper-'));
  t.after(async () => { const target = resolve(directory); assert.ok(target.startsWith(resolve(tmpdir()) + sep)); await rm(target, { recursive: true, force: true }); });
  const f = fixture(); t.after(() => f.service.stop()); await f.create();
  const store = await openPerpetualPaperStore(directory); await store.save(f.saved());
  const loaded = await openPerpetualPaperStore(directory); assert.deepEqual(loaded.get(), f.saved());
  assert.ok((await stat(join(directory, 'paper-positions.json'))).size < 10_000);
  const invalid = f.saved(); invalid.positions[0].samples = Array.from({ length: 289 }, (_, index) => [NOW + index * 300_000, 0]);
  await assert.rejects(store.save(invalid)); assert.deepEqual(loaded.get(), f.saved());
  const corrupt = JSON.parse(await readFile(join(directory, 'paper-positions.json'), 'utf8')); corrupt.positions[0].quantity = 0;
  await writeFile(join(directory, 'paper-positions.json'), JSON.stringify(corrupt));
  await assert.rejects(openPerpetualPaperStore(directory), /无法读取/);
  await writeFile(join(directory, 'paper-positions.json'), 'x'.repeat(limits.fileBytes + 1));
  await assert.rejects(openPerpetualPaperStore(directory), /无法读取/);
});

test('an interrupted fixed temporary file is overwritten on next save while the committed journal survives restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-paper-recovery-'));
  t.after(async () => { const target = resolve(directory); assert.ok(target.startsWith(resolve(tmpdir()) + sep)); await rm(target, { recursive: true, force: true }); });
  const f = fixture(); t.after(() => f.service.stop()); await f.create({ requestId: 'restart-registration' });
  const store = await openPerpetualPaperStore(directory); await store.save(f.saved());
  const committed = f.saved(), temporary = join(directory, 'paper-positions.json.tmp');
  await writeFile(temporary, 'interrupted-write'.repeat(1000));
  const restarted = await openPerpetualPaperStore(directory);
  assert.deepEqual(restarted.get(), committed, 'Incomplete temporary data never replaces the committed journal on load');
  await f.command('update', { changes: { settledFunding: 123 } });
  await restarted.save(f.saved());
  assert.deepEqual((await openPerpetualPaperStore(directory)).get(), f.saved());
  await assert.rejects(stat(temporary), error => error.code === 'ENOENT', 'Atomic replacement consumes the single temporary file');
});

test('full retention budget stays below 1 MB and optional paper-store failure remains explicit', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.create({ note: '测试'.repeat(100) });
  const template = f.saved().positions[0], state = initialPerpetualPaperState();
  const points = Array.from({ length: limits.samples }, (_, index) => [NOW + index * limits.sampleIntervalMs, -123456789.12345678]);
  for (let index = 0; index < limits.active; index++) state.positions.push({ ...structuredClone(template), id: `active-${index}`, samples: points });
  for (let index = 0; index < limits.closed; index++) state.positions.push({ ...structuredClone(template), id: `closed-${index}`, status: 'stopped', samples: points.slice(0, 12),
    close: { kind: 'stop', closedAt: NOW, exitLongPrice: null, exitShortPrice: null, closeFeePaid: null, settledFunding: 2, pnl: null } });
  assert.ok(Buffer.byteLength(JSON.stringify(validatePerpetualPaperState(state))) < limits.fileBytes);
  const unavailable = createPerpetualPaperService({ unavailableReason: '纸面记录损坏，行情继续' });
  assert.equal(unavailable.view().available, false); assert.match(unavailable.view().error, /损坏/);
  await assert.rejects(unavailable.update({ revision: 0, action: 'create', position: draft() }), /损坏/);
});

test('paper API uses existing authenticated JSON routes and reports revision conflicts', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const services = new Map([['perpetual', { actions: { paper: ['GET', 'POST'] }, handle: (_, method, input) => method === 'POST' ? f.service.update(input) : f.service.view() }]]);
  const server = createServer(createHandler({ services, username: 'test', password: 'local-only', nextHandler: (_, response) => response.end() }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/paper`, headers = { authorization: `Basic ${Buffer.from('test:local-only').toString('base64')}`, 'content-type': 'application/json' };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://elsewhere.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: 0, action: 'create', position: draft() }) })).status, 200);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: 0, action: 'create', position: draft() }) })).status, 409);
  assert.equal((await (await fetch(url, { headers })).json()).positions.length, 1);
});

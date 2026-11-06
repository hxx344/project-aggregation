import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANTHROPIC_CANDLE_ACTION, ANTHROPIC_CANDLE_MS, anthropicCandleWindow, anthropicChartRows, anthropicPremium, createAnthropicCandles, createBinanceGate,
  fetchAnthropicCandles, fetchAnthropicQuote, validateAnthropicCandles, validateAnthropicQuote,
} from '../modules/anthropic/market.mjs';
import { openMarketStore } from '../server/market-store.mjs';
import { openMonitorControlStore } from '../server/monitor-control.mjs';
import { readHubSummary } from '../server/hub-summary.mjs';
import { createHandler } from '../server/http.mjs';
import { anthropicHistory } from '../lib/anthropic-history.ts';

const BAR = ANTHROPIC_CANDLE_MS, DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12, 7);
const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = status => ({ ok: false, status, json: async () => ({}) });
const hlContext = (name, markPx, isDelisted = false) => [{ universe: [{ name: 'other' }, { name, isDelisted }] }, [{ markPx: '1' }, { markPx: String(markPx), funding: '0.00001', oraclePx: String(markPx) }]];

/** Routes Binance GETs and Hyperliquid POSTs; `binance`/`hl` return a response or throw. */
function fetcher({ binance, hl }) {
  const calls = [];
  const fn = async (url, init = {}) => {
    if (init.method === 'POST') { const body = JSON.parse(init.body); calls.push({ hl: body }); return hl(body); }
    const parsed = new URL(url); calls.push({ binance: parsed.pathname, params: Object.fromEntries(parsed.searchParams) });
    return binance(parsed);
  };
  return Object.assign(fn, { calls });
}

test('quote converts every leg to per-share prices and keeps a failed leg as a reason', async () => {
  const quote = await fetchAnthropicQuote({ now: NOW, fetcher: fetcher({
    binance: () => fail(451),
    hl: body => ok(hlContext(body.dex === 'xyz' ? 'xyz:ANT' : 'io:ANTH', body.dex === 'xyz' ? 95 : 1603.2)),
  }) });
  assert.equal(quote.binance, null);
  assert.match(quote.errors.binance, /451/);
  assert.equal(quote.xyz.markPx, 95);
  assert.equal(quote.io.markPx, 1603.2);
  assert.equal(quote.fetchedAt, new Date(NOW).toISOString());
  // 1206.5 / 12.7 = 95 per share, 1603.2 / 16.7 = 96 per share.
  assert.ok(Math.abs(anthropicPremium(1206.5, 95, 'xyz')) < 1e-9);
  assert.ok(Math.abs(anthropicPremium(1206.5, 1603.2, 'io') - (95 / 96 - 1) * 100) < 1e-9);
  assert.equal(anthropicPremium(null, 95, 'xyz'), null);
  await assert.rejects(fetchAnthropicQuote({ now: NOW, fetcher: fetcher({ binance: () => fail(500), hl: () => fail(500) }) }), /No Anthropic quote/);
  // Wrong market names are rejected rather than read as Anthropic.
  const wrong = await fetchAnthropicQuote({ now: NOW, fetcher: fetcher({ binance: () => ok({ symbol: 'ANTHROPICUSDT', markPrice: '1200', lastFundingRate: '0.0001', nextFundingTime: NOW + 3_600_000 }), hl: () => ok(hlContext('xyz:OTHER', 1)) }) });
  assert.equal(wrong.binance.markPx, 1200); assert.equal(wrong.xyz, null); assert.equal(wrong.io, null);
  assert.throws(() => validateAnthropicQuote({ ...wrong, binance: { markPx: -1 } }));
});

const kline = (time, close) => [time, '1', '1', '1', String(close), '1', time + BAR - 1];
const candle = (coin, time, close) => ({ t: time, T: time + BAR - 1, s: coin, i: '15m', c: String(close), o: '1', h: '1', l: '1', v: '1', n: 1 });
const lastClosed = Math.floor(NOW / BAR) * BAR - BAR;

test('candles merge three legs, skip the open bar, and resume a failed leg from its own last close', async () => {
  const times = [lastClosed - 2 * BAR, lastClosed - BAR, lastClosed, lastClosed + BAR];
  const first = fetcher({
    binance: url => ok(times.filter(time => time >= Number(url.searchParams.get('startTime'))).map((time, index) => kline(time, 1200 + index))),
    hl: body => body.req.coin === 'io:ANTH' ? fail(500) : ok(times.map(time => candle('xyz:ANT', time, 95))),
  });
  const snapshot = await fetchAnthropicCandles(null, { now: NOW, fetcher: first });
  assert.equal(snapshot.data.length, 3, 'the still-open bar is not stored');
  assert.deepEqual(snapshot.data.map(row => [row.binance, row.xyz, row.io]), [[1200, 95, null], [1201, 95, null], [1202, 95, null]]);
  assert.equal(first.calls.find(call => call.binance)?.params.startTime, String(Math.floor((NOW - 50 * DAY) / BAR) * BAR));
  validateAnthropicCandles(snapshot);

  const later = NOW + BAR, second = fetcher({ binance: url => ok([kline(Number(url.searchParams.get('startTime')), 1300)]), hl: body => ok([candle(body.req.coin, lastClosed + BAR, body.req.coin === 'io:ANTH' ? 1600 : 96)]) });
  const resumed = await fetchAnthropicCandles(snapshot, { now: later, fetcher: second });
  const starts = Object.fromEntries(second.calls.map(call => call.hl ? [call.hl.req.coin, call.hl.req.startTime] : ['binance', Number(call.params.startTime)]));
  assert.equal(starts.binance, lastClosed - 96 * BAR);
  assert.equal(starts['xyz:ANT'], lastClosed - 96 * BAR);
  assert.equal(starts['io:ANTH'], Math.min(snapshot.data[0].time, Math.floor((later - 50 * DAY) / BAR) * BAR), 'a leg that never succeeded backfills the initial window');
  assert.deepEqual(resumed.data.at(-1), { time: lastClosed + BAR, binance: null, xyz: 96, io: 1600 });
  assert.equal(resumed.data.length, 5, 'the overlap read adds the earlier Binance bar');
});

test('Binance candle pages continue until a short page', async () => {
  const start = Math.floor((NOW - 50 * DAY) / BAR) * BAR, total = Math.floor((NOW - start) / BAR);
  const binance = fetcher({ binance: url => { const from = Number(url.searchParams.get('startTime')), limit = Number(url.searchParams.get('limit')); const rows = []; for (let time = from; time < NOW && rows.length < limit; time += BAR) rows.push(kline(time, 1000)); return ok(rows); }, hl: () => fail(500) });
  const snapshot = await fetchAnthropicCandles(null, { now: NOW, fetcher: binance });
  assert.equal(binance.calls.filter(call => call.binance).length, Math.ceil((total + 1) / 1500));
  assert.equal(snapshot.data.length, total);
});

test('chart rows, windowed reads and the market store keep the per-share premium and coverage', async () => {
  const rows = [0, 1, 2, 3].map(index => ({ time: lastClosed - (3 - index) * DAY, binance: 1270, xyz: index === 1 ? null : 100, io: 1670 }));
  const snapshot = createAnthropicCandles(rows, new Date(NOW).toISOString());
  const chart = anthropicChartRows(snapshot.data, 'xyz');
  assert.equal(chart.length, 3);
  assert.deepEqual(chart[0], { time: rows[0].time, adr: 100, ordinary: 100, equivalent: 100, spread: 0, premium: 0 });
  assert.equal(anthropicChartRows(snapshot.data, 'io').length, 4);
  const window = anthropicCandleWindow({ ...snapshot }, 1);
  assert.equal(window.data.length, 2);
  assert.equal(window.windowDays, 1);
  assert.deepEqual(window.coverage, { firstObservation: snapshot.metadata.firstObservation, lastObservation: snapshot.metadata.lastObservation, rows: 4 });

  const directory = await mkdtemp(join(tmpdir(), 'anthropic-store-'));
  let store;
  try {
    store = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => NOW });
    assert.throws(() => store.read('anthropic', 'quote'), /尚未收到/);
    store.write('anthropic', ANTHROPIC_CANDLE_ACTION, snapshot);
    store.write('anthropic', 'quote', { fetchedAt: new Date(NOW).toISOString(), binance: { markPx: 1270, fundingRate: 0.0001, nextFundingTime: null }, xyz: null, io: null, errors: { xyz: '请求超时' } });
    const quote = store.read('anthropic', 'quote');
    assert.equal(quote.status, 'live'); assert.equal(quote.errors.xyz, '请求超时'); assert.equal(quote.errors.io, '暂无报价');
    assert.equal(validateAnthropicCandles(store.read('anthropic', ANTHROPIC_CANDLE_ACTION)).data.length, 4);
    assert.throws(() => store.write('anthropic', 'quote', { fetchedAt: new Date(NOW).toISOString(), binance: null, xyz: null, io: null }), error => error.code === 'MARKET_DATA_INVALID');
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a switch file saved before the Anthropic monitor existed starts it enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-control-'));
  try {
    const monitors = Object.fromEntries(['oil', 'hynix', 'perpetual'].map(id => [id, { enabled: id !== 'oil', revision: 2 }]));
    await writeFile(join(directory, 'monitor-control.json'), JSON.stringify({ version: 1, monitors }));
    const loaded = (await openMonitorControlStore(directory)).get();
    assert.deepEqual(loaded.monitors.anthropic, { enabled: true, revision: 0 });
    assert.deepEqual(loaded.monitors.oil, { enabled: false, revision: 2 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('hub summary reports both premiums and names a missing leg as partial', async () => {
  const fetchedAt = new Date(NOW).toISOString();
  const quote = { fetchedAt, status: 'live', binance: { markPx: 1270 }, xyz: { markPx: 99 }, io: null, errors: { io: '请求超时' } };
  const summary = await readHubSummary(new Map([['anthropic', { handle: async () => quote }]]), NOW + 1000, 'anthropic');
  assert.equal(summary.health.state, 'partial');
  assert.match(summary.health.message, /io:ANTH 请求超时/);
  assert.ok(Math.abs(summary.metrics[0].value - (100 / 99 - 1) * 100) < 1e-9);
  assert.equal(summary.metrics[1].value, null);
  const stale = await readHubSummary(new Map([['anthropic', { handle: async () => ({ ...quote, io: { markPx: 1670 }, errors: {} }) }]]), NOW + 60_000, 'anthropic');
  assert.equal(stale.health.state, 'stale');
  assert.equal(stale.metrics[1].value, 0);
});

test('Binance 429/418 starts a cooldown shared by quotes and candles, and a delisted Hyperliquid market is not a live quote', async () => {
  const gate = createBinanceGate();
  let binanceCalls = 0;
  const limited = fetcher({ binance: () => { binanceCalls++; return fail(429); }, hl: body => ok(hlContext(body.dex === 'xyz' ? 'xyz:ANT' : 'io:ANTH', 95, body.dex === 'io')) });
  const first = await fetchAnthropicQuote({ now: NOW, fetcher: limited, gate, clock: () => NOW });
  assert.match(first.errors.binance, /429/);
  assert.equal(first.errors.io, '合约已下架');
  assert.equal(first.xyz.markPx, 95);
  const cooled = await fetchAnthropicQuote({ now: NOW + 59_000, fetcher: limited, gate, clock: () => NOW + 59_000 });
  assert.equal(binanceCalls, 1, 'no Binance request inside the cooldown');
  assert.equal(cooled.errors.binance, '接口限流冷却中（HTTP 429）');
  const candles = await fetchAnthropicCandles(null, { now: NOW + 59_000, fetcher: fetcher({ binance: () => { binanceCalls++; return fail(429); }, hl: body => ok([candle(body.req.coin, lastClosed, 95)]) }), gate, clock: () => NOW + 59_000 });
  assert.equal(binanceCalls, 1);
  assert.equal(candles.metadata.errors.binance, '接口限流冷却中（HTTP 429）');
  await fetchAnthropicQuote({ now: NOW + 60_000, fetcher: limited, gate, clock: () => NOW + 60_000 });
  assert.equal(binanceCalls, 2, 'the cooldown ends after 60 s');
  const banned = fetcher({ binance: () => fail(418), hl: body => ok(hlContext(body.dex === 'xyz' ? 'xyz:ANT' : 'io:ANTH', 95)) });
  await fetchAnthropicQuote({ now: NOW + 130_000, fetcher: banned, gate, clock: () => NOW + 130_000 });
  assert.match((await fetchAnthropicQuote({ now: NOW + 249_000, fetcher: banned, gate, clock: () => NOW + 249_000 })).errors.binance, /冷却中（HTTP 418）/);
});

test('a failed candle leg is reported in the snapshot, survives store, window and client validation, and clears on success', async () => {
  const gate = createBinanceGate();
  const broken = fetcher({ binance: () => ok([kline(lastClosed, 1270)]), hl: body => body.req.coin === 'io:ANTH' ? fail(500) : ok([candle('xyz:ANT', lastClosed, 100)]) });
  const snapshot = await fetchAnthropicCandles(null, { now: NOW, fetcher: broken, gate });
  assert.deepEqual(snapshot.metadata.errors, { io: '接口返回 HTTP 500' });
  assert.deepEqual(validateAnthropicCandles(JSON.parse(JSON.stringify(snapshot))).metadata.errors, { io: '接口返回 HTTP 500' });
  assert.deepEqual(anthropicHistory(snapshot).errors, { io: '接口返回 HTTP 500' });
  // Snapshots saved before leg errors existed still validate.
  const legacy = JSON.parse(JSON.stringify(snapshot)); delete legacy.metadata.errors;
  assert.deepEqual(validateAnthropicCandles(legacy).metadata.errors, {});
  assert.throws(() => validateAnthropicCandles({ ...snapshot, metadata: { ...snapshot.metadata, errors: { other: 'x' } } }), /leg error/);
  const healed = await fetchAnthropicCandles(snapshot, { now: NOW, fetcher: fetcher({ binance: () => ok([kline(lastClosed, 1270)]), hl: body => ok([candle(body.req.coin, lastClosed, 100)]) }), gate });
  assert.deepEqual(healed.metadata.errors, {});
  // Hyperliquid candles must be 15-minute bars in ascending order.
  const duplicate = fetcher({ binance: () => fail(500), hl: body => ok([candle(body.req.coin, lastClosed, 100), candle(body.req.coin, lastClosed, 101)]) });
  await assert.rejects(fetchAnthropicCandles(null, { now: NOW, fetcher: duplicate, gate }));
  const hourly = fetcher({ binance: () => fail(500), hl: body => ok([{ ...candle(body.req.coin, lastClosed, 100), i: '1h' }]) });
  await assert.rejects(fetchAnthropicCandles(null, { now: NOW, fetcher: hourly, gate }));
});

test('the candles API windows Anthropic history with its own coverage, which the client accepts', async t => {
  const rows = Array.from({ length: 40 * 96 }, (_, index) => ({ time: lastClosed - index * BAR, binance: 1270, xyz: 100, io: 1670 })).reverse();
  const archive = { ...createAnthropicCandles(rows, new Date(NOW).toISOString()), collection: { source: 'database', stale: false } };
  const calls = [];
  const services = new Map([['anthropic', { actions: { [ANTHROPIC_CANDLE_ACTION]: ['GET'], quote: ['GET'] }, async handle(action) { calls.push(action); return archive; } }]]);
  const password = 'anthropic-window-password';
  const server = createServer(createHandler({ services, username: 'admin', password, nextHandler: (_q, r) => r.writeHead(404).end() }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = path => new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port: server.address().port, path, headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }).on('error', reject).end();
  });
  const window = await get(`/api/monitors/anthropic/${ANTHROPIC_CANDLE_ACTION}?days=8`);
  assert.equal(window.status, 200);
  assert.equal(window.json.windowDays, 8);
  const history = anthropicHistory(window.json);
  assert.equal(history.windowDays, 8);
  assert.deepEqual(history.coverage, { firstObservation: archive.metadata.firstObservation, lastObservation: archive.metadata.lastObservation, rows: rows.length });
  assert.ok(history.rows.length < rows.length);
  assert.throws(() => anthropicHistory({ ...window.json, coverage: { ...window.json.coverage, rows: 1 } }), /coverage/);
  assert.equal(anthropicHistory((await get(`/api/monitors/anthropic/${ANTHROPIC_CANDLE_ACTION}`)).json).windowDays, null);
  const before = calls.length;
  for (const days of ['0', 'x', '401']) assert.equal((await get(`/api/monitors/anthropic/${ANTHROPIC_CANDLE_ACTION}?days=${days}`)).status, 400);
  assert.equal(calls.length, before, 'an invalid window never reads the dataset');
});

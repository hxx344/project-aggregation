import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoldOilReader } from '../lib/gold-oil-service.ts';
import { GOLD_OIL_INTERVAL_MS as STEP, GOLD_OIL_VARIANTS, goldOilAction, goldOilChartPoints, validateGoldOilHistory } from '../lib/gold-oil.ts';
import { openMarketStore } from '../server/market-store.mjs';

const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 16), START = NOW - 20000 * STEP;
const candle = (time, price) => [time, String(price), String(price), String(price), String(price), '0', time + STEP - 1];

function fixture(variant, missing = new Map()) {
  let now = NOW;
  const calls = [], failures = new Set();
  const symbol = variant.oilType === 'cl' ? 'CLUSDT' : 'BZUSDT';
  const value = (leg, time) => missing.get(time)?.includes(leg) ? null : leg === 'xau' ? 4000 : 80;
  const history = validateGoldOilHistory({ ...variant, source: variant.exchange === 'bybit' ? 'Bybit' : 'Binance', currency: 'USDT', priceBasis: 'mark', interval: '15m', status: 'live', fetchedAt: new Date(now).toISOString(), coverageStart: START,
    points: Array.from({ length: 20000 }, (_, index) => { const time = START + index * STEP; return { time, oil: value('oil', time), xau: value('xau', time) }; }),
  }, variant.oilType, variant.exchange);
  const fetcher = async input => {
    const url = new URL(input), requested = url.searchParams.get('symbol'), bybit = variant.exchange === 'bybit';
    const wrap = list => ({ retCode: 0, time: now, result: { category: 'linear', symbol: requested, list } });
    if (url.pathname.endsWith('exchangeInfo')) return Response.json({ symbols: [symbol, 'XAUUSDT'].map(symbol => ({ symbol, baseAsset: symbol.slice(0, -4), quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING', onboardDate: START })) });
    if (url.pathname.endsWith('instruments-info')) return Response.json(wrap([{ symbol: requested, baseCoin: requested.slice(0, -4), quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', isPreListing: false, launchTime: START, fundingInterval: 480 }]));
    const from = Number(url.searchParams.get(bybit ? 'start' : 'startTime')), to = Number(url.searchParams.get(bybit ? 'end' : 'endTime')) + 1;
    const leg = requested === 'XAUUSDT' ? 'xau' : 'oil';
    calls.push({ from, to, leg });
    const recent = from >= now - 2 * DAY;
    if (failures.has(recent ? 'recent' : 'repair')) return new Response('', { status: 503 });
    const rows = [];
    for (let time = from; time < to; time += STEP) {
      const price = value(leg, time);
      if (price !== null) rows.push(candle(time, price + (leg === 'oil' ? recent ? 2 : 1 : 0)));
    }
    if (bybit) return Response.json(wrap(rows.reverse().slice(0, 1000)));
    return Response.json(rows.slice(0, 1000));
  };
  return { calls, failures, missing, history, clock: () => now, advance: ms => { now += ms; }, reader: () => createGoldOilReader({ ...variant, clock: () => now, fetcher }) };
}

for (const variant of GOLD_OIL_VARIANTS) {
  const name = `${variant.exchange}/${variant.oilType}`;
  test(`${name}: 20k saved candles repair one old day, persist cooldown and avoid repeated full downloads after restart`, async t => {
    const gap = START + 10 * STEP, f = fixture(variant, new Map([[gap, ['xau']]]));
    const first = await f.reader().history(f.history);
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.slice(0, 2).every(call => call.from >= NOW - 2 * DAY));
    assert.ok(f.calls.slice(2).every(call => call.from === gap && call.to - call.from === DAY));
    assert.equal(first.points.find(point => point.time === gap).xau, null);
    assert.equal(first.points.at(-1).oil, 82, 'Recent corrections are retained');
    assert.equal(first.points.find(point => point.time === gap + STEP).oil, 80, 'Repair does not revise existing old prices');
    assert.equal(first.historyRepair.nextCheckAt, NOW + 6 * 3_600_000);
    const directory = await mkdtemp(join(tmpdir(), 'gold-oil-history-repair-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, 'market.sqlite'), action = goldOilAction('history', variant.oilType, variant.exchange);
    let store = await openMarketStore(filename, { clock: f.clock });
    store.write('cl-xau', action, first); store.close();
    store = await openMarketStore(filename, { clock: f.clock });
    let saved;
    try { saved = store.raw('cl-xau', action); } finally { store.close(); }
    assert.deepEqual(saved.historyRepair, first.historyRepair);
    f.advance(60_000);
    for (let pass = 0; pass < 2; pass++) {
      f.calls.length = 0;
      saved = await f.reader().history(saved);
      assert.equal(f.calls.length, 2, 'A recreated reader only reads recent candles during cooldown');
      assert.equal(saved.points.find(point => point.time === gap).xau, null);
    }
    f.advance(6 * 3_600_000);
    f.missing.delete(gap); f.calls.length = 0;
    const recovered = await f.reader().history(saved);
    assert.equal(f.calls.length, 4);
    assert.equal(recovered.points.find(point => point.time === gap).xau, 4000);
    assert.equal(recovered.points.find(point => point.time === gap).oil, 80);
    assert.equal(recovered.coverageStart, START);
    assert.equal(recovered.fetchedAt, new Date(f.clock()).toISOString());
  });

  test(`${name}: a failed old window preserves recent success and cannot starve later gaps`, async () => {
    const firstGap = START + 10 * STEP, secondGap = START + 300 * STEP;
    const f = fixture(variant, new Map([[firstGap, ['xau']], [secondGap, ['xau']]]));
    f.failures.add('repair'); f.advance(60_000);
    const failed = await f.reader().history(f.history);
    assert.equal(f.calls.length, 4);
    assert.equal(failed.fetchedAt, new Date(f.clock()).toISOString());
    assert.equal(failed.points.at(-1).oil, 82);
    assert.equal(failed.points.find(point => point.time === firstGap).xau, null);
    assert.ok(failed.historyRepair.cursor > firstGap);
    f.failures.clear(); f.missing.delete(secondGap); f.calls.length = 0;
    const next = await f.reader().history(validateGoldOilHistory(JSON.parse(JSON.stringify(failed)), variant.oilType, variant.exchange));
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.slice(2).every(call => call.from === secondGap));
    assert.equal(next.points.find(point => point.time === secondGap).xau, 4000);
    assert.equal(next.points.find(point => point.time === firstGap).xau, null);
    f.failures.add('recent'); f.calls.length = 0;
    const retained = structuredClone(next);
    await assert.rejects(f.reader().history(next));
    assert.deepEqual(next, retained, 'A real recent failure cannot relabel or mutate the saved snapshot');
    assert.equal(f.calls.length, 2);
  });

  test(`${name}: leading missing candles and entirely empty old windows stay bounded without fabricated prices`, async () => {
    const f = fixture(variant);
    const leading = { ...f.history, points: f.history.points.slice(1) };
    const repaired = await f.reader().history(leading);
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.slice(2).every(call => call.from === START && call.to === START + DAY));
    assert.equal(repaired.points[0].time, START);
    const missing = new Map(Array.from({ length: 120 }, (_, index) => [START + index * STEP, ['oil', 'xau']]));
    const empty = fixture(variant, missing);
    let result = await empty.reader().history(empty.history);
    assert.equal(empty.calls.length, 4);
    assert.ok(goldOilChartPoints(result, 0).slice(0, 120).every(point => point.oil === null && point.xau === null && point.ratio === null));
    empty.calls.length = 0;
    result = await empty.reader().history(result);
    assert.equal(empty.calls.length, 4);
    assert.ok(empty.calls.slice(2).every(call => call.from === START + DAY && call.to - call.from === DAY));
    assert.ok(goldOilChartPoints(result, 0).slice(0, 120).every(point => point.ratio === null));
    empty.calls.length = 0;
    await empty.reader().history(result);
    assert.equal(empty.calls.length, 2, 'An entirely empty scanned window observes the sweep cooldown');
  });
}

test('legacy histories remain valid and malformed persistent repair state is rejected', () => {
  const f = fixture({ oilType: 'cl', exchange: 'binance' });
  assert.equal(validateGoldOilHistory(f.history).historyRepair, undefined);
  for (const historyRepair of [null, [], { cursor: START + 1, nextCheckAt: 0 }, { cursor: NOW + STEP, nextCheckAt: 0 }, { cursor: START, nextCheckAt: NaN }, { cursor: START, nextCheckAt: NOW + 2 * DAY }]) {
    assert.throws(() => validateGoldOilHistory({ ...f.history, historyRepair }), /repair|data/);
  }
});

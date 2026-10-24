import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHubSummary, readHubSummary } from '../lib/hub-summary.ts';
import { openDatabase } from '../lib/sqlite.ts';

const now = Date.parse('2026-09-22T17:00:00Z');
const fresh = new Date(now - 1000).toISOString();
const asset = (mode = 'market', updatedAt: string | null = fresh, value: number | null = 100) => ({ project: 'asset', mode, updatedAt, value });
const input = () => ({ assets: [asset()], fx: 7, fxStatus: { fetchedAt: fresh, error: null }, example: false, history: [] });

test('Variational account equity is counted once and remains dynamic on failure', () => {
  const read = (row: ReturnType<typeof asset> & {error?: string}) => buildHubSummary({...input(),assets:[row]},now).data;
  const current=read(asset('variational',fresh,123.45));
  assert.equal(current.health.state,'online');
  assert.equal(current.metrics[0].value,123.45);
  assert.equal(current.freshness,undefined);
  assert.equal(read(asset('variational','2020-01-01T00:00:00Z')).health.state,'stale');
  const failed=read({...asset('variational'),error:'Var 会话已失效'});
  assert.equal(failed.health.state,'partial');
  assert.doesNotMatch(failed.health.message,/未识别/);
});

test('Binance balances are known dynamic assets and retain stale/error states', () => {
  const read = (row: ReturnType<typeof asset> & {error?: string}) => buildHubSummary({...input(),assets:[row]},now).data;
  const freshBalance=read(asset('binance',fresh,125));
  assert.equal(freshBalance.health.state,'online');
  assert.equal(freshBalance.metrics[0].value,125);
  assert.equal(freshBalance.freshness,undefined);
  assert.equal(read(asset('binance','2020-01-01T00:00:00Z')).health.state,'stale');
  const failed=read({...asset('binance'),error:'同步失败'});
  assert.equal(failed.health.state,'partial');
  assert.doesNotMatch(failed.health.message,/未识别/);
});

test('OKX balances are known dynamic assets and retain stale/error states', () => {
  const read = (row: ReturnType<typeof asset> & {error?: string}) => buildHubSummary({...input(),assets:[row]},now).data;
  const freshBalance=read(asset('okx',fresh,125));
  assert.equal(freshBalance.health.state,'online');
  assert.equal(freshBalance.metrics[0].value,125);
  assert.equal(freshBalance.freshness,undefined);
  assert.equal(read(asset('okx','2020-01-01T00:00:00Z')).health.state,'stale');
  const failed=read({...asset('okx'),error:'同步失败'});
  assert.equal(failed.health.state,'partial');
  assert.doesNotMatch(failed.health.message,/未识别/);
});

test('Gate USD estimates count once and retain source failure and age in the summary', () => {
  const read = (row: ReturnType<typeof asset> & {error?: string}) => buildHubSummary({...input(),assets:[row]},now).data;
  const current = read(asset('gate',fresh,125.5));
  assert.equal(current.health.state,'online');
  assert.equal(current.metrics[0].value,125.5);
  assert.equal(current.metrics.find(metric => metric.key === 'holdings')?.value,125.5);
  assert.equal(current.freshness,undefined);
  assert.equal(read(asset('gate','2020-01-01T00:00:00Z')).health.state,'stale');
  assert.equal(read(asset('gate',fresh,0)).metrics[0].value,0);
  assert.equal(read(asset('gate',fresh,null)).health.state,'partial');
  const failed = read({...asset('gate'),error:'Gate 读取失败'});
  assert.equal(failed.health.state,'partial');
  assert.doesNotMatch(failed.health.message,/未识别/);
});

test('disconnected single-account exchanges retain valuations without a live freshness requirement', () => {
  const old = '2020-01-01T00:00:00.000Z';
  for (const mode of ['bybit', 'binance', 'okx', 'gate', 'variational']) {
    const source = { ...input(), connectedExchanges: [], assets: [{ ...asset(mode, old, 123.45), error: 'Previous sync failed' }] };
    const original = structuredClone(source);
    const summary = buildHubSummary(source, now).data;
    assert.equal(summary.health.state, 'online', mode);
    assert.equal(summary.freshness, 'static');
    assert.equal(summary.updatedAt, old, 'Do not turn disconnect time into a fresh valuation');
    assert.equal(summary.metrics.find(metric => metric.key === 'ledger_total')?.value, 123.45);
    assert.equal(summary.metrics.find(metric => metric.key === 'retained_valuation_at')?.value, old);
    assert.match(summary.health.message, /未连接账户保留原估值/);
    assert.doesNotMatch(summary.health.message, /更新失败|源时间已过期/);
    assert.deepEqual(source, original);

    const connected = buildHubSummary({ ...source, connectedExchanges: [mode] }, now).data;
    assert.equal(connected.health.state, 'partial', 'Saved but expired credentials remain a failure');
    assert.equal(connected.freshness, undefined);
    assert.match(connected.health.message, /更新失败.*源时间已过期/);
    assert.equal(buildHubSummary({ ...source, connectedExchanges: [mode], assets: [asset(mode, old)] }, now).data.health.state, 'stale');
  }
});

test('retained valuations do not age active data or hide independent missing data and FX failures', () => {
  const retained = asset('variational', '2020-01-01T00:00:00.000Z', 125);
  const source = { ...input(), connectedExchanges: ['okx'], assets: [retained, asset('okx', fresh, 200)] };
  const summary = buildHubSummary(source, now).data;
  assert.equal(summary.health.state, 'online');
  assert.equal(summary.freshness, undefined);
  assert.equal(summary.updatedAt, fresh);
  assert.equal(summary.metrics[0].value, 325);
  assert.equal(buildHubSummary({ ...source, assets: [retained, asset('okx', null)] }, now).data.health.state, 'stale');
  assert.equal(buildHubSummary({ ...source, assets: [{ ...retained, value: null }, asset('okx')] }, now).data.health.state, 'partial');
  assert.equal(buildHubSummary({ ...source, fxStatus: { fetchedAt: fresh, error: 'FX failed' } }, now).data.health.state, 'partial');
  assert.equal(buildHubSummary({ ...source, assets: [retained, asset('market', null)] }, now).data.health.state, 'stale');
  assert.equal(buildHubSummary({ ...source, assets: [retained, asset('unrecognized')] }, now).data.health.state, 'partial');
  assert.equal(buildHubSummary({ ...source, assets: [retained, asset('aster', null)] }, now).data.health.state, 'stale', 'Aster multi-account handling is unchanged');
  assert.equal(buildHubSummary({ ...source, assets: [asset('variational', null)] }, now).data.health.state, 'partial', 'A retained record still needs a valid valuation time');
});

test('summary reads live owner-scoped connections so existing disconnected VAR records recover without a rewrite', async () => {
  const database = openDatabase(':memory:');
  try {
    const row = { ...asset('variational', '2020-01-01T00:00:00.000Z', 125), status: '已断开 · 保留旧值' };
    const persisted = JSON.stringify(row);
    await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-var', persisted).run();
    for (const [key, value] of Object.entries({ fx: '7', 'fx-status': JSON.stringify({ fetchedAt: fresh }), 'source-ledger': JSON.stringify({ source: 'personal', periods: [] }) })) {
      await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', key, value).run();
    }
    await database.prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?)').bind('other-owner', 'variational', 'must-not-be-read', fresh).run();
    const before = (await readHubSummary(database, 'owner', now)).data;
    assert.equal(before.health.state, 'online');
    assert.equal(before.freshness, 'static');
    assert.equal(before.updatedAt, row.updatedAt);

    await database.prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?)').bind('owner', 'variational', 'must-not-be-read', fresh).run();
    const active = (await readHubSummary(database, 'owner', now)).data;
    assert.equal(active.health.state, 'stale', 'The actual connection overrides the old status text');
    assert.equal(active.freshness, undefined);
    await database.prepare('DELETE FROM connections WHERE owner = ? AND exchange = ?').bind('owner', 'variational').run();
    const disconnected = (await readHubSummary(database, 'owner', now)).data;
    assert.equal(disconnected.health.state, 'online');
    assert.equal(disconnected.freshness, 'static');
    assert.equal(disconnected.metrics[0].value, 125);
    assert.equal((await database.prepare('SELECT data FROM assets WHERE owner = ? AND id = ?').bind('owner', 'row-var').first<{ data: string }>())?.data, persisted);
    assert.doesNotMatch(JSON.stringify(disconnected), /must-not-be-read|已断开/);
  } finally { database.close(); }
});

test('summary preserves ledger totals, withdrawals, oldest dynamic time and CNY/USD units', () => {
  const result = buildHubSummary({ ...input(), assets: [asset('market', fresh), asset('aster', '2026-09-22T16:58:00Z', 200), { ...asset('manual', '2020-01-01T00:00:00Z', 25), project: ' 出金 ' }] }, now);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.data.updatedAt, '2026-09-22T16:58:00.000Z');
  assert.equal(result.data.health.state, 'online');
  assert.equal(result.data.health.staleAfterSeconds, 900);
  const metrics = Object.fromEntries(result.data.metrics.map(metric => [metric.key, metric]));
  assert.equal(metrics.ledger_total.value, 325);
  assert.equal(metrics.holdings.value, 300);
  assert.equal(metrics.manual_valuation_at.value, '2020-01-01T00:00:00.000Z');
  assert.equal(metrics.fx.unit, 'CNY/USD');
});

test('recorded withdrawals update ledger totals through the Beijing day without changing holdings or source rows', () => {
  const source = {
    ...input(),
    assets: [asset('market', fresh, 300), { ...asset('manual', fresh, 25), project: ' 出金 ' }],
    withdrawals: [{ date: '2026-09-22', amount: 10 }, { date: '2026-09-23', amount: 20 }, { date: '2026-09-24', amount: 900 }],
  };
  const original = structuredClone(source);
  const result = buildHubSummary(source, now).data;
  const metrics = Object.fromEntries(result.metrics.map(metric => [metric.key, metric]));
  assert.equal(metrics.ledger_total.value, 355);
  assert.equal(metrics.holdings.value, 300);
  assert.equal(metrics.entries.value, 2);
  assert.match(metrics.ledger_total.detail!, /原表出金.*新增出金/);
  assert.deepEqual(source, original);
});

test('trend adds recorded withdrawals by date after the original baseline and on daily baseline snapshots', () => {
  const source = {
    ...input(), baselineDate: '2026-09-22',
    withdrawals: [{ date: '2026-09-22', amount: 10 }, { date: '2026-09-23', amount: 20 }, { date: '2026-09-24', amount: 900 }],
    history: [
      { id: 'original-before', date: '2026-09-21', total: 100 },
      { id: 'original-baseline', date: '2026-09-22', total: 200 },
      { id: 'original-after', date: '2026-09-23', total: 300 },
      { id: 'original-future', date: '2026-09-24', total: 400 },
    ],
  };
  const original = structuredClone(source);
  assert.deepEqual(buildHubSummary(source, now).data.trend, [
    { at: '2026-09-21T00:00:00+08:00', value: 100 },
    { at: '2026-09-22T00:00:00+08:00', value: 200 },
    { at: '2026-09-23T00:00:00+08:00', value: 330 },
  ]);
  const daily = buildHubSummary({ ...source, history: [...source.history, { id: 'daily-2026-09-22', date: '2026-09-22', total: 250 }] }, now).data;
  assert.equal(daily.trend.find(point => point.at.startsWith('2026-09-22'))?.value, 260);
  assert.deepEqual(source, original);
});

test('recorded withdrawals preserve unknown valuations and partial health', () => {
  const result = buildHubSummary({
    ...input(), assets: [asset('market', fresh, 100), { ...asset('manual', fresh, null), project: '出金' }],
    withdrawals: [{ date: '2026-09-23', amount: 40 }],
    history: [{ id: 'daily-2026-09-23', date: '2026-09-23', total: null }],
  }, now).data;
  assert.equal(result.metrics.find(metric => metric.key === 'ledger_total')?.value, null);
  assert.equal(result.metrics.find(metric => metric.key === 'holdings')?.value, null);
  assert.equal(result.health.state, 'partial');
  assert.deepEqual(result.trend, []);
});

test('only explicit manual valuations are static; missing dynamic sources and FX errors stay visible', () => {
  const manual = buildHubSummary({ ...input(), assets: [asset('manual', '2020-01-01T00:00:00Z')] }, now).data;
  assert.equal(manual.freshness, 'static');
  assert.equal(manual.health.state, 'online');
  const unknown = buildHubSummary({ ...input(), assets: [asset('unrecognized')] }, now).data;
  assert.equal(unknown.freshness, undefined);
  assert.equal(unknown.health.state, 'partial');
  assert.match(unknown.health.message, /未识别/);
  const missingTime = buildHubSummary({ ...input(), assets: [asset(), asset('aster', null)] }, now).data;
  assert.equal(missingTime.updatedAt, null);
  assert.equal(missingTime.health.state, 'stale');
  assert.equal(buildHubSummary({ ...input(), assets: [asset('market', '2020-01-01T00:00:00Z')] }, now).data.health.state, 'stale');
  const fxError = buildHubSummary({ ...input(), assets: [asset('manual')], fxStatus: { fetchedAt: fresh, error: 'FX failed' } }, now).data;
  assert.equal(fxError.freshness, 'static');
  assert.equal(fxError.health.state, 'partial');
  assert.match(fxError.health.message, /汇率/);
  const missingValue = buildHubSummary({ ...input(), assets: [asset('manual', fresh, null)] }, now).data;
  assert.equal(missingValue.metrics[0].value, null);
  assert.equal(missingValue.health.state, 'partial');
});

test('trend chooses the last original and daily total, skips invalid/future/archived dates and retains 90 distinct dates', () => {
  const history = Array.from({ length: 100 }, (_, index) => ({ id: 'original-' + index, date: new Date(Date.parse('2026-06-16T00:00:00Z') + index * 86400000).toISOString().slice(0, 10), total: index }));
  const result = buildHubSummary({ ...input(), history: [
    ...history, { id: 'original-later', date: '2026-09-22', total: 1000 },
    { id: 'daily-2026-09-22', date: '2026-09-22', total: 2000 },
    { id: 'original-last', date: '2026-09-22', total: 3000 },
    { id: 'daily-2026-09-23', date: '2026-09-23', total: 4000 },
    { id: 'future', date: '2026-09-24', total: 9999 },
    { id: 'archived', date: '2026-09-23', total: 9999, archived: true },
    { id: 'prefill', date: '2026-09-23', total: 9999, future: true },
    { id: 'invalid', date: '2026-02-30', total: 9999 },
  ] }, now).data;
  assert.equal(result.trend.length, 90);
  assert.deepEqual(result.trend.slice(-2), [{ at: '2026-09-22T00:00:00+08:00', value: 2000 }, { at: '2026-09-23T00:00:00+08:00', value: 4000 }]);
  assert.match(result.health.message, /非收益曲线/);
});

test('summary reads owner-scoped projected totals and finds 90 valid days beyond archived and invalid newest rows', async () => {
  const database = openDatabase(':memory:');
  try {
    await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-1', JSON.stringify({ ...asset(), details: [{ privateHistoryMarker: 'not-in-summary' }] })).run();
    await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('other', 'row-1', JSON.stringify(asset('manual', fresh, 999999))).run();
    for (const [key, value] of Object.entries({ fx: '7', 'fx-status': JSON.stringify({ fetchedAt: fresh }), 'source-ledger': JSON.stringify({ source: 'personal', periods: [{ id: 'E1', date: '2026-09-22', total: 1, rows: [{ value: 1, privateHistoryMarker: 'not-in-summary' }] }] }) })) {
      await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', key, value).run();
    }
    for (let index = 0; index < 100; index++) {
      const date = new Date(Date.parse('2026-06-16T00:00:00Z') + index * 86400000).toISOString().slice(0, 10);
      await database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', date, JSON.stringify({ id: 'daily-' + date, date, total: index, assets: [{ privateHistoryMarker: 'not-in-summary', value: 123456 }] })).run();
    }
    await database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', 'archive-recent', JSON.stringify({ id: 'archive-recent', date: '2026-09-23', total: 9999, archived: true })).run();
    const result = await readHubSummary(database, 'owner', now);
    assert.equal(result.data.metrics[0].value, 100);
    assert.equal(result.data.trend.length, 90);
    assert.deepEqual(result.data.trend.at(-1), { at: '2026-09-23T00:00:00+08:00', value: 99 });
    assert.equal(result.data.trend.find(point => point.at.startsWith('2026-09-22'))?.value, 98);
    assert.equal(JSON.stringify(result).includes('privateHistoryMarker'), false);
  } finally { database.close(); }
});

test('owner-scoped recorded withdrawal additions, edits and deletions recalculate current and historical totals without rewriting snapshots', async () => {
  const database = openDatabase(':memory:');
  try {
    const rows = [asset('market', fresh, 300), { ...asset('manual', fresh, 25), project: '出金' }];
    for (const [index, row] of rows.entries()) {
      await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-' + index, JSON.stringify(row)).run();
    }
    const source = JSON.stringify({ source: 'personal', baselineDate: '2026-09-21', periods: [
      { id: 'baseline', date: '2026-09-21', total: 300, rows: [{ value: 300, privateHistoryMarker: 'not-in-summary' }] },
      { id: 'original-after', date: '2026-09-22', total: 310 },
    ] });
    const snapshot = JSON.stringify({ id: 'daily-2026-09-23', date: '2026-09-23', total: 325, assets: rows });
    for (const [key, value] of Object.entries({ fx: '7', 'fx-status': JSON.stringify({ fetchedAt: fresh }), 'source-ledger': source })) {
      await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', key, value).run();
    }
    await database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', '2026-09-23', snapshot).run();
    await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('other', 'withdrawals', JSON.stringify([{ date: '2026-09-21', amount: 999999 }])).run();
    await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('other', 'source-ledger', JSON.stringify({ baselineDate: '2000-01-01', periods: [{ id: 'other', date: '2026-09-22', total: 999999 }] })).run();

    const check = async (current: number, history: number[]) => {
      const result = await readHubSummary(database, 'owner', now);
      assert.equal(result.data.metrics.find(metric => metric.key === 'ledger_total')?.value, current);
      assert.equal(result.data.metrics.find(metric => metric.key === 'holdings')?.value, 300);
      assert.deepEqual(result.data.trend.map(point => point.value), history);
      assert.doesNotMatch(JSON.stringify(result), /privateHistoryMarker|privateWithdrawalMarker/);
    };
    await check(325, [300, 310, 325]);
    const baseline = { id: 'baseline-withdrawal', date: '2026-09-21', amount: 5, note: 'privateWithdrawalMarker' };
    const recorded = { id: 'recorded', date: '2026-09-22', amount: 10, note: 'privateWithdrawalMarker' };
    const today = { id: 'today', date: '2026-09-23', amount: 20, note: 'privateWithdrawalMarker' };
    const future = { id: 'future', date: '2026-09-24', amount: 900, note: 'privateWithdrawalMarker' };
    const save = async (withdrawals: typeof recorded[]) => database.prepare('INSERT INTO settings VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind('owner', 'withdrawals', JSON.stringify(withdrawals)).run();
    await save([baseline, recorded, today, future]);
    await check(360, [300, 325, 360]);
    await save([baseline, { ...recorded, amount: 30 }, today, future]);
    await check(380, [300, 345, 380]);
    await save([baseline, today, future]);
    await check(350, [300, 315, 350]);
    await save([]);
    await check(325, [300, 310, 325]);
    assert.equal((await database.prepare("SELECT value FROM settings WHERE owner = ? AND key = 'source-ledger'").bind('owner').first<{ value: string }>())?.value, source);
    assert.equal((await database.prepare('SELECT data FROM snapshots WHERE owner = ? AND date = ?').bind('owner', '2026-09-23').first<{ data: string }>())?.data, snapshot);
    const persistedAssets = await database.prepare('SELECT data FROM assets WHERE owner = ? ORDER BY id').bind('owner').all<{ data: string }>();
    assert.deepEqual(persistedAssets.results.map(row => JSON.parse(row.data)), rows);
  } finally { database.close(); }
});

test('hub trend omits incomplete subtotals without reviving an older same-day total, while real zero stays visible', async () => {
  const database = openDatabase(':memory:');
  try {
    await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-1', JSON.stringify(asset('manual', fresh, null))).run();
    await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', 'source-ledger', JSON.stringify({ source: 'personal', periods: [
      { id: 'E1', date: '2026-09-22', total: 200, rows: [{ value: 200 }] },
    ] })).run();
    const snapshots = [
      { id: 'daily-2026-09-22', date: '2026-09-22', total: 100, assets: [{ value: 100 }, { value: null }] },
      { id: 'daily-2026-09-23', date: '2026-09-23', total: 0, assets: [{ value: 0 }] },
    ];
    for (const row of snapshots) await database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', row.date, JSON.stringify(row)).run();
    const result = await readHubSummary(database, 'owner', now);
    assert.equal(result.data.health.state, 'partial');
    assert.equal(result.data.metrics[0].value, null);
    assert.deepEqual(result.data.trend, [{ at: '2026-09-23T00:00:00+08:00', value: 0 }]);
    assert.match(result.data.health.message, /估值缺失/);
  } finally { database.close(); }
});

test('hub trend keeps workbook columns whose blank cells were not yet held, but omits uncached formulas', async t => {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const blank = { value: null, quantity: null, price: null, formula: null };
  await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-1', JSON.stringify(asset('manual', fresh, 1))).run();
  await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', 'source-ledger', JSON.stringify({ source: 'personal', periods: [
    { id: 'E1', date: '2026-09-20', total: 300, rows: [{ value: 300 }, blank] },
    { id: 'F1', date: '2026-09-21', total: 400, rows: [{ value: 400 }, { ...blank, formula: '=C3*D3' }] },
  ] })).run();
  const trend = (await readHubSummary(database, 'owner', now)).data.trend;
  assert.deepEqual(trend, [{ at: '2026-09-20T00:00:00+08:00', value: 300 }]);
});

test('hub trend keeps the 90-day window when incomplete days are omitted', async t => {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const days = Array.from({ length: 91 }, (_, index) => new Date(Date.parse('2026-09-23T00:00:00Z') - (90 - index) * 86_400_000).toISOString().slice(0, 10));
  await database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-1', JSON.stringify(asset('manual', fresh, 1))).run();
  await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', 'source-ledger', JSON.stringify({ source: 'personal', periods: [
    { id: 'E1', date: days[0], total: 500, rows: [{ value: 500 }] },
  ] })).run();
  for (const [index, date] of days.entries()) {
    const missing = index === 0 || index === 90;
    const snapshot = { id: `daily-${date}`, date, total: 1, assets: [{ value: 1 }, ...(missing ? [{ value: null }] : [])] };
    await database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', date, JSON.stringify(snapshot)).run();
  }
  const trend = (await readHubSummary(database, 'owner', now)).data.trend;
  assert.equal(trend.length, 89);
  assert.equal(trend[0].at, `${days[1]}T00:00:00+08:00`);
  assert.equal(trend.at(-1)?.at, `${days[89]}T00:00:00+08:00`);
  assert.ok(trend.every(point => point.value === 1));
});

test('hub current metrics reject determinable legacy market zeros and preserve genuine zero quantities', () => {
  for (const quantity of [null, 0]) {
    const source = { ...input(), assets: [asset('manual', fresh, 100), { ...asset('market', fresh, 0), quantity, price: 2.5 }] };
    const original = structuredClone(source);
    const result = buildHubSummary(source, now).data;
    assert.equal(result.health.state, quantity === null ? 'partial' : 'online');
    assert.equal(result.metrics[0].value, quantity === null ? null : 100);
    assert.equal(result.metrics.find(metric => metric.key === 'holdings')?.value, quantity === null ? null : 100);
    assert.deepEqual(source, original);
  }
});

test('hub SQL derives legacy zero incompleteness even with missingValues zero and leaves stored records intact', async t => {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const legacy = { ...asset('market', fresh, 0), project: 'virtual', quantity: null, price: 2.5, privateMarker: 'not-in-summary' };
  const known = asset('manual', fresh, 100);
  const source = JSON.stringify({ source: 'personal', periods: [
    { id: 'D1', date: '2026-09-20', total: 100, rows: [known, legacy] },
    { id: 'E1', date: '2026-09-21', total: 999, rows: [{ value: 999 }] },
    { id: 'F1', date: '2026-09-22', total: 888, rows: [{ value: 888 }] },
  ] });
  const snapshots = [
    { id: 'daily-2026-09-21', date: '2026-09-21', total: 100, partial: false, assets: [known, legacy] },
    { id: 'daily-2026-09-22', date: '2026-09-22', total: 100, partial: false, missingValues: 0, assets: [known, legacy] },
    { id: 'daily-2026-09-23', date: '2026-09-23', total: 0, partial: false, missingValues: 0, assets: [{ ...legacy, quantity: 0 }] },
  ];
  await database.batch([
    database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-1', JSON.stringify(legacy)),
    database.prepare('INSERT INTO assets VALUES(?,?,?)').bind('owner', 'row-2', JSON.stringify(known)),
    ...Object.entries({ fx: '7', 'fx-status': JSON.stringify({ fetchedAt: fresh }), 'source-ledger': source }).map(([key, value]) =>
      database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', key, value)),
    ...snapshots.map(snapshot => database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', snapshot.date, JSON.stringify(snapshot))),
  ]);
  const summary = (await readHubSummary(database, 'owner', now)).data;
  assert.equal(summary.health.state, 'partial');
  assert.equal(summary.metrics[0].value, null);
  assert.equal(summary.metrics.find(metric => metric.key === 'holdings')?.value, null);
  assert.deepEqual(summary.trend, [{ at: '2026-09-23T00:00:00+08:00', value: 0 }], 'incomplete daily totals must not revive same-day original totals');
  assert.doesNotMatch(JSON.stringify(summary), /privateMarker|not-in-summary/);
  assert.equal((await database.prepare('SELECT data FROM assets WHERE owner=? AND id=?').bind('owner', 'row-1').first<{ data: string }>())?.data, JSON.stringify(legacy));
  const stored = await database.prepare('SELECT data FROM snapshots WHERE owner=? ORDER BY date').bind('owner').all<{ data: string }>();
  assert.deepEqual(stored.results.map(row => row.data), snapshots.map(row => JSON.stringify(row)));
  assert.equal((await database.prepare("SELECT value FROM settings WHERE owner=? AND key='source-ledger'").bind('owner').first<{ value: string }>())?.value, source);

  await database.prepare('UPDATE assets SET data=? WHERE owner=? AND id=?').bind(JSON.stringify({ ...legacy, quantity: 0 }), 'owner', 'row-1').run();
  const zero = (await readHubSummary(database, 'owner', now)).data;
  assert.equal(zero.health.state, 'online');
  assert.equal(zero.metrics[0].value, 100);
});

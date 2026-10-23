import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDailyChanges, readDailyChanges, type ChangeSnapshot } from '../lib/daily-changes.ts';
import { comparePositions, type GroupId, type PositionAnalysis } from '../lib/daily-positions.ts';
import { openDatabase } from '../lib/sqlite.ts';
import { readSnapshotHistory } from '../lib/snapshot-history.ts';

const row = (id: string, project: string, value: number | null, kind = '资产') => ({ id, project, kind, value });
const snap = (date: string, rows: ChangeSnapshot['rows'], extra: Partial<ChangeSnapshot> = {}): ChangeSnapshot => ({
  id: 'daily-' + date, date, total: rows.reduce((sum, item) => sum + (item.value ?? 0), 0), rows, ...extra,
});
const base = { withdrawals: [], baselineDate: '2026-01-01', today: '2026-10-23' };

test('attributes each change to asset rows, separates withdrawals and sorts by size', () => {
  const report = calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [row('row-1', 'bybit', 1000), row('row-2', 'virtual', 200), row('row-3', '出金', 50)]),
    snap('2026-10-22', [row('row-1', 'bybit', 900), row('row-2', 'virtual', 230), row('row-3', '出金', 50)]),
  ], withdrawals: [{ date: '2026-10-22', amount: 100 }] });
  const [day] = report.days;
  assert.equal(report.days.length, 1);
  assert.deepEqual(day.sources.map(source => [source.project, source.change]), [['bybit', -100], ['virtual', 30]]);
  assert.equal(day.withdrawnChange, 100);
  assert.equal(day.heldChange, -70);
  assert.equal(day.change, 30);
  assert.equal(day.unattributed, 0);
  assert.equal(day.change, day.sources.reduce((sum, source) => sum + source.change, 0) + day.withdrawnChange + day.unattributed);
});

test('compares observed days without interpolation and keeps the base before the window', () => {
  const report = calculateDailyChanges({ ...base, days: 3, snapshots: [
    snap('2026-10-10', [row('row-1', 'a', 100)]),
    snap('2026-10-15', [row('row-1', 'a', 110)]),
    snap('2026-10-21', [row('row-1', 'a', 130)], { partial: true }),
    snap('2026-10-23', [row('row-1', 'a', 125)]),
    snap('2026-10-24', [row('row-1', 'a', 999)]),
  ] });
  assert.equal(report.windowStart, '2026-10-21');
  assert.deepEqual(report.days.map(day => [day.date, day.previousDate, day.gapDays, day.change, day.partial]),
    [['2026-10-23', '2026-10-21', 2, -5, true], ['2026-10-21', '2026-10-15', 6, 20, true]]);
});

test('added, removed and missing rows remain visible; tiny float noise is not a source', () => {
  const [day] = calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [row('row-1', 'old', 40), row('row-2', 'same', 0.1 + 0.2), row('row-3', 'gone', null)]),
    snap('2026-10-22', [row('row-2', 'same', 0.3), row('row-4', 'new', 15)]),
  ] }).days;
  assert.deepEqual(day.sources.map(source => [source.project, source.previous, source.current, source.change]),
    [['old', 40, null, -40], ['new', null, 15, 15]]);
});

test('daily snapshot overrides original columns; future, archived and invalid days are excluded', () => {
  const original = (id: string, date: string, total: number, rows: ReturnType<typeof row>[], extra: Partial<ChangeSnapshot> = {}) => ({ id, date, total, rows, ...extra });
  const report = calculateDailyChanges({ ...base, baselineDate: '2026-10-20', snapshots: [
    original('D1', '2026-10-20', 1010, [row('row-1', 'a', 1000)]),
    original('E1', '2026-10-21', 1, [row('row-1', 'a', 1)]),
    snap('2026-10-21', [row('row-1', 'a', 1100)]),
    original('F1', '2026-10-22', 5000, [row('row-1', 'a', 5000)], { future: true }),
    { ...snap('2026-10-22', [row('row-1', 'a', 7000)]), archived: true },
    snap('2026-13-01', [row('row-1', 'a', 7000)]),
  ] });
  assert.equal(report.days.length, 1);
  const [day] = report.days;
  assert.equal(day.previousDate, '2026-10-20');
  assert.equal(day.change, 90);
  assert.equal(day.sources[0].change, 100);
  assert.equal(day.unattributed, -10, 'workbook total above its row sum has no row source');
});

test('unknown existing asset values are not compared as zero or attributed as gains and losses', () => {
  const [day] = calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [row('row-1', 'unknown-next', 100), row('row-2', 'known', 100)]),
    snap('2026-10-22', [row('row-1', 'unknown-next', null), row('row-2', 'known', 120)]),
  ] }).days;
  assert.equal(day.partial, true, 'legacy snapshots also derive completeness from their rows');
  assert.equal(day.change, -80, 'the displayed difference remains the difference of known subtotals');
  assert.deepEqual(day.sources.map(source => [source.project, source.change]), [['known', 20]]);
  assert.equal(day.unattributed, -100, 'a changed known-value range is not an asset loss');
  const [zero] = calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [row('row-1', 'known', 100)]),
    snap('2026-10-22', [row('row-1', 'known', 0)]),
  ] }).days;
  assert.equal(zero.partial, false);
  assert.equal(zero.sources[0].change, -100, 'a genuine zero remains a known loss');
});

test('legacy market zeros moving to or from a known quantity stay unattributed; genuine zero remains comparable', () => {
  const market = (quantity: number | null, value: number) => ({ ...row('row-2', 'virtual', value), mode: 'market', quantity });
  for (const [previous, current, difference] of [
    [market(null, 0), market(20, 50), 50],
    [market(20, 50), market(null, 0), -50],
  ] as const) {
    const [day] = calculateDailyChanges({ ...base, snapshots: [
      snap('2026-10-21', [row('row-1', 'known', 100), previous], { partial: false }),
      snap('2026-10-22', [row('row-1', 'known', 100), current], { partial: false }),
    ] }).days;
    assert.equal(day.partial, true);
    assert.deepEqual(day.sources, []);
    assert.equal(day.withdrawnChange, 0);
    assert.equal(day.change, difference);
    assert.equal(day.unattributed, difference);
  }
  const [zero] = calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [row('row-1', 'known', 100), market(0, 0)]),
    snap('2026-10-22', [row('row-1', 'known', 100), market(20, 50)]),
  ] }).days;
  assert.equal(zero.partial, false);
  assert.equal(zero.sources[0].change, 50);
  assert.equal(zero.unattributed, 0);
});

test('missing embedded withdrawals are not fabricated flows and real zero amounts remain comparable', () => {
  for (const [previous, current, expectedWithdrawn, expectedUnattributed, partial] of [
    [null, 100, 0, 100, true], [100, null, 0, -100, true],
    [100, 0, -100, 0, false], [0, 100, 100, 0, false],
  ] as const) {
    const [day] = calculateDailyChanges({ ...base, snapshots: [
      snap('2026-10-21', [row('row-1', 'known', 100), row('row-2', ' 出金 ', previous)], { withdrawn: previous ?? 0, partial: false }),
      snap('2026-10-22', [row('row-1', 'known', 100), row('row-2', '出金', current)], { withdrawn: current ?? 0, partial: false }),
    ] }).days;
    assert.equal(day.partial, partial);
    assert.deepEqual(day.sources, []);
    assert.equal(day.heldChange, 0);
    assert.equal(day.withdrawnChange, expectedWithdrawn);
    assert.equal(day.unattributed, expectedUnattributed);
    assert.equal(day.change, day.withdrawnChange + day.unattributed);
  }
});

test('known embedded withdrawal pairs and real recorded withdrawals remain attributable beside an unknown row', () => {
  const [day] = calculateDailyChanges({ ...base, withdrawals: [{ date: '2026-10-22', amount: 25 }], snapshots: [
    snap('2026-10-21', [row('row-1', 'known', 100), row('row-2', '出金', null), row('row-3', '出金', 20)]),
    snap('2026-10-22', [row('row-1', 'known', 90), row('row-2', '出金', 100), row('row-3', '出金', 30)]),
  ] }).days;
  assert.equal(day.partial, true);
  assert.equal(day.sources[0].change, -10);
  assert.equal(day.withdrawnChange, 35, 'only the known original pair (+10) and the actual record (+25) are flows');
  assert.equal(day.unattributed, 100);
  assert.equal(day.change, 125);
  assert.equal(day.change, day.sources.reduce((sum, source) => sum + source.change, 0) + day.withdrawnChange + day.unattributed);
});

test('unmatched cumulative workbook withdrawal rows are not treated as new recorded withdrawals', () => {
  for (const added of [true, false]) {
    const holding = row('row-1', 'known', 100), embedded = row('row-2', '出金', 100);
    const [day] = calculateDailyChanges({ ...base, snapshots: [
      snap('2026-10-21', added ? [holding] : [holding, embedded]),
      snap('2026-10-22', added ? [holding, embedded] : [holding]),
    ] }).days;
    assert.equal(day.partial, true);
    assert.equal(day.withdrawnChange, 0);
    assert.equal(day.unattributed, added ? 100 : -100);
  }
});

test('daily reader preserves legacy market unknown quantities and compares a genuine zero correctly', async t => {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const rows = [
    { date: '2026-10-20', quantity: null, value: 0 }, { date: '2026-10-21', quantity: 20, value: 50 },
    { date: '2026-10-22', quantity: 0, value: 0 }, { date: '2026-10-23', quantity: null, value: 0 },
  ].map(({ date, quantity, value }) => ({
    id: 'daily-' + date, date, total: 100 + value, partial: false, missingValues: 0,
    assets: [row('row-1', 'known', 100), { ...row('row-2', 'virtual', value), quantity, price: 2.5, mode: 'market' }],
  }));
  await database.batch(rows.map(snapshot => database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', snapshot.date, JSON.stringify(snapshot))));
  const report = await readDailyChanges(database, 'owner', Date.parse('2026-10-23T04:00:00Z'));
  assert.deepEqual(report.days.map(day => [day.change, day.partial, day.unattributed]), [[0, true, 0], [-50, false, 0], [50, true, 50]]);
  assert.deepEqual(report.days.map(day => day.sources.map(source => source.change)), [[], [-50], []]);
  const stored = await database.prepare('SELECT data FROM snapshots WHERE owner=? ORDER BY date').bind('owner').all<{ data: string }>();
  assert.deepEqual(stored.results.map(row => row.data), rows.map(row => JSON.stringify(row)));
});

test('reader detects missing original withdrawals in both workbook columns and daily snapshots', async t => {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const columns = [
    { id: 'E1', date: '2026-10-21', total: 100, rows: [row('row-1', 'known', 100), row('row-2', '出金', null)] },
    { id: 'F1', date: '2026-10-22', total: 200, rows: [row('row-1', 'known', 100), row('row-2', '出金', 100)] },
  ];
  await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('source', 'source-ledger', JSON.stringify({ baselineDate: '2026-10-21', periods: columns })).run();
  await database.batch(columns.map(({ rows, ...period }) => database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('daily', period.date, JSON.stringify({
    ...period, id: 'daily-' + period.date, partial: false, withdrawn: period.total - 100, assets: rows,
  }))));
  for (const owner of ['source', 'daily']) {
    const [day] = (await readDailyChanges(database, owner, Date.parse('2026-10-23T04:00:00Z'))).days;
    assert.equal(day.partial, true);
    assert.equal(day.withdrawnChange, 0);
    assert.equal(day.unattributed, 100);
    assert.deepEqual(day.sources, []);
  }
});

test('recorded withdrawals before the workbook baseline are not counted twice on original columns', () => {
  const report = calculateDailyChanges({ ...base, baselineDate: '2026-10-21', withdrawals: [{ date: '2026-10-21', amount: 30 }], snapshots: [
    { id: 'E1', date: '2026-10-21', total: 100, rows: [row('row-1', 'a', 100)] },
    snap('2026-10-22', [row('row-1', 'a', 70)]),
  ] });
  assert.equal(report.days[0].withdrawnChange, 30);
  assert.equal(report.days[0].change, 0);
});

test('reader is owner scoped, uses the latest earlier snapshot as base and ignores archives', async () => {
  const database = openDatabase(':memory:');
  try {
    const now = Date.parse('2026-10-23T04:00:00Z');
    const insert = (owner: string, key: string, data: unknown) => database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind(owner, key, JSON.stringify(data)).run();
    const daily = (date: string, value: number) => ({ id: 'daily-' + date, date, total: value, withdrawn: 0, assets: [{ ...row('row-1', 'bybit', value), details: [{ privateMarker: 'not-returned' }] }] });
    await insert('owner', '2026-01-01', daily('2026-01-01', 10));
    await insert('owner', '2026-07-20', daily('2026-07-20', 100));
    for (const [date, value] of [['2026-07-26', 120], ['2026-10-22', 150], ['2026-10-23', 140]] as const) await insert('owner', date, daily(date, value));
    await insert('owner', 'archive-x', { ...daily('2026-10-22', 99999), id: 'archive-x', archived: true });
    await insert('other', '2026-10-22', daily('2026-10-22', 88888));
    await database.prepare('INSERT INTO settings VALUES(?,?,?)').bind('owner', 'withdrawals', JSON.stringify([{ date: '2026-10-23', amount: 5 }])).run();
    const report = await readDailyChanges(database, 'owner', now);
    assert.equal(report.today, '2026-10-23');
    assert.equal(report.windowStart, '2026-07-26');
    assert.deepEqual(report.days.map(day => [day.date, day.previousDate, day.change]),
      [['2026-10-23', '2026-10-22', -5], ['2026-10-22', '2026-07-26', 30], ['2026-07-26', '2026-07-20', 20]]);
    assert.equal(JSON.stringify(report).includes('privateMarker'), false);
    assert.equal((await readDailyChanges(database, 'missing', now)).days.length, 0);
  } finally { database.close(); }
});

const usdt = (value: number, price = 0.999) => ({ coin: 'USDT', account: 'USDⓈ-M 合约（折合 USDT）', value, price });
const leg = (symbol: string, side: 'long' | 'short', quantity: string, upnl: string, cycle: { since: string; net: string | null; updatedAt?: string } | null) => ({
  id: symbol + ':' + side, symbol, instrumentId: symbol, side, quantity, quantityUnit: symbol.replace('USDT', ''), unrealizedPnl: upnl, pnlCurrency: 'USDT',
  cycle: cycle && { status: 'complete' as const, since: cycle.since, realizedPnl: null, fees: null, funding: null, net: cycle.net, currency: 'USDT', updatedAt: cycle.updatedAt ?? null as string | null },
});
const capture = (at: string, positions: ReturnType<typeof leg>[], status: 'live' | 'stale' = 'live') => ({ capturedAt: at, scopes: [
  { exchange: 'binance', account: 'default', accountName: '默认账号', generation: 'g1', scope: 'pm-um', status, fetchedAt: at,
    positions: positions.map(item => item.cycle ? { ...item, cycle: { ...item.cycle, updatedAt: item.cycle.updatedAt ?? at } } : item) },
] });
const binance = (value: number, details = [usdt(value)]) => ({ id: 'row-9', project: 'binance', kind: '资产', value, mode: 'binance', details });

test('exchange rows break down by account and coin; lines without both sides of details are not invented', () => {
  const [day] = calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [binance(1000, [usdt(800), { coin: 'USDT', account: '资金账户（折合 USDT）', value: 200, price: 1 }]), row('row-1', 'bybit', 50)]),
    snap('2026-10-22', [binance(1030, [usdt(850), { coin: 'USDT', account: '资金账户（折合 USDT）', value: 180, price: 1 }]), { ...row('row-1', 'bybit', 60), details: [{ coin: 'BTC', account: '统一账户', value: 60, price: 60 }] }]),
  ] }).days;
  const source = day.sources.find(item => item.project === 'binance')!;
  assert.deepEqual(source.details.map(item => [item.label, item.change]), [['USDⓈ-M 合约（折合 USDT） · USDT', 50], ['资金账户（折合 USDT） · USDT', -20]]);
  assert.deepEqual(day.sources.find(item => item.project === 'bybit')!.details, []);
  assert.equal(day.positions, null, 'snapshots without holdings have no position analysis');
});

const group = (positions: PositionAnalysis, id: GroupId) => positions.groups.find(item => item.id === id)!;
const legs = (previous: ReturnType<typeof capture> | undefined, current: ReturnType<typeof capture>, rows = [binance(1010)]) => comparePositions({ previous, current, rows });

test('holdings split into crude-oil, SK hynix and other totals in USD at the snapshot stablecoin price', () => {
  const since = '2026-10-10T00:00:00.000Z';
  const previous = capture('2026-10-21T15:00:00.000Z', [
    leg('CLUSDT', 'long', '10', '10', { since, net: '1' }), leg('BZUSDT', 'short', '10', '-5', { since, net: '2' }),
    leg('SKHYUSDT', 'short', '3', '4', { since, net: '0.5' }), leg('CLOUDUSDT', 'long', '1', '0', { since, net: '0' }), leg('BTCUSDT', 'long', '1', '20', { since, net: '0' }),
  ]);
  const current = capture('2026-10-22T15:00:00.000Z', [
    leg('CLUSDT', 'long', '10', '15', { since, net: '1.5' }), leg('BZUSDT', 'short', '10', '-8', { since, net: '2' }),
    leg('SKHYNIXUSDT', 'long', '2', '2', { since: '2026-10-22T03:00:00.000Z', net: '-0.3' }), leg('CLOUDUSDT', 'long', '1', '1', { since, net: '0' }), leg('BTCUSDT', 'long', '1', '10', { since, net: '-1' }),
  ]);
  const [day] = calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [binance(1000)], { positions: previous }), snap('2026-10-22', [binance(1010)], { positions: current }),
  ] }).days;
  const positions = day.positions!;
  assert.equal(positions.compared, true);
  assert.deepEqual(positions.groups.map(item => [item.id, item.label]), [['oil', '原油套利'], ['hynix', '海力士套利'], ['other', '其他持仓']]);
  const oil = group(positions, 'oil'), hynix = group(positions, 'hynix'), other = group(positions, 'other');
  assert.ok(Math.abs(oil.change! - 2.5 * 0.999) < 1e-9); assert.equal(oil.complete, true); assert.equal(oil.legs, 2);
  assert.ok(Math.abs(hynix.change! - 1.7 * 0.999) < 1e-9, 'opened after the previous capture counts its whole cycle; the closed leg is unknown');
  assert.equal(hynix.complete, false); assert.equal(hynix.legs, 2);
  assert.ok(Math.abs(other.change! - (1 - 11) * 0.999) < 1e-9, 'CLOUD is not crude oil and lands in other holdings');
  assert.equal(other.complete, true); assert.equal(other.legs, 2);
  const by = (symbol: string) => legs(previous, current).positions.find(item => item.symbol === symbol)!;
  assert.equal(by('SKHYUSDT').change, null); assert.equal(by('SKHYUSDT').note, '已平仓，平仓盈亏未单独统计');
  assert.equal(by('CLOUDUSDT').combo, null);
});

test('stale scopes, first captures, new cycles and missing prices stay unknown or partial', () => {
  const since = '2026-10-10T00:00:00.000Z';
  const day = (previous: ReturnType<typeof capture> | undefined, current: ReturnType<typeof capture>) => calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [binance(1000)], previous ? { positions: previous } : {}), snap('2026-10-22', [binance(1010)], { positions: current }),
  ] }).days[0].positions!;
  const before = capture('2026-10-21T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '10', { since, net: '1' })]);
  const reopenedAt = capture('2026-10-22T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '12', { since: '2026-10-22T01:00:00.000Z', net: '-3' })]);
  const reopened = legs(before, reopenedAt).positions[0];
  assert.equal(reopened.cashFlowChange, null); assert.equal(reopened.partial, true);
  assert.equal(group(day(before, reopenedAt), 'oil').complete, false);
  const stale = day(before, capture('2026-10-22T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '12', { since, net: '1' })], 'stale'));
  assert.equal(group(stale, 'oil').change, null, 'an all-unknown group is unknown, not zero');
  assert.equal(group(stale, 'hynix').change, null, 'an empty group is not zero while a scope is unreadable');
  assert.equal(group(stale, 'other').complete, false);
  const first = day(undefined, capture('2026-10-22T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '12', { since, net: '1' })]));
  assert.equal(first.compared, false); assert.equal(first.recorded, true); assert.deepEqual(first.groups, []);
  const noRate = legs(before, capture('2026-10-22T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '12', { since, net: '1' })]), [binance(1010, [])]);
  assert.equal(noRate.positions[0].change, null, 'USDT is never assumed to equal USD');
});

test('reader returns validated holdings and history reads never load them', async () => {
  const database = openDatabase(':memory:');
  try {
    const since = '2026-10-10T00:00:00.000Z';
    const insert = (date: string, data: unknown) => database.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind('owner', date, JSON.stringify(data)).run();
    const daily = (date: string, value: number, positions: unknown) => ({ id: 'daily-' + date, date, total: value, withdrawn: 0, assets: [binance(value)], positions });
    await insert('2026-10-21', daily('2026-10-21', 1000, capture('2026-10-21T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '10', { since, net: '1' })])));
    await insert('2026-10-22', daily('2026-10-22', 1010, capture('2026-10-22T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '12', { since, net: '1' })])));
    await insert('2026-10-23', daily('2026-10-23', 1020, { capturedAt: '2026-10-23T01:00:00.000Z', scopes: [{ exchange: 'binance', positions: 'bad' }] }));
    const report = await readDailyChanges(database, 'owner', Date.parse('2026-10-23T04:00:00Z'));
    assert.equal(report.days[0].positions, null, 'malformed stored holdings are dropped');
    const stored = report.days[1].positions!;
    assert.ok(Math.abs(group(stored, 'oil').change! - 2 * 0.999) < 1e-9); assert.equal(group(stored, 'oil').complete, true);
    assert.equal(group(stored, 'hynix').change, 0, 'a fully read capture without hynix legs is zero');
    const history = await readSnapshotHistory(database, 'owner');
    assert.equal(history.some(period => 'positions' in period || 'assets' in period), false);
  } finally { database.close(); }
});

test('unknown holdings never become zero: cold caches and replaced credentials', () => {
  const since = '2026-10-10T00:00:00.000Z';
  const day = (previous: ReturnType<typeof capture>, current: ReturnType<typeof capture>) => calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [binance(1000)], { positions: previous }), snap('2026-10-22', [binance(1010)], { positions: current }),
  ] }).days[0].positions!;
  const emptyLive = day(capture('2026-10-21T15:00:00.000Z', []), capture('2026-10-22T15:00:00.000Z', []));
  assert.ok(emptyLive.groups.every(item => item.change === 0 && item.complete), 'live scopes without holdings are zero');
  const cold = day({ capturedAt: '2026-10-21T15:00:00.000Z', scopes: [] }, { capturedAt: '2026-10-22T15:00:00.000Z', scopes: [] });
  assert.ok(cold.groups.every(item => item.change === null && !item.complete), 'a cold cache proves nothing');
  assert.equal(cold.recorded, false);
  const replaced = capture('2026-10-22T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '0', { since, net: '0' })]);
  replaced.scopes[0].generation = 'other-account';
  const previous = capture('2026-10-21T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '100', { since, net: '0' })]);
  const switched = legs(previous, replaced).positions;
  assert.ok(switched.every(item => item.change === null), 'a replaced credential is not compared with the old account');
  assert.equal(new Set(switched.map(item => item.key)).size, switched.length);
  assert.equal(group(day(previous, replaced), 'oil').change, null);
});

test('an exchange row with offsetting account moves stays visible', () => {
  const [day] = calculateDailyChanges({ ...base, snapshots: [
    snap('2026-10-21', [binance(100, [usdt(80), { coin: 'USDT', account: '现货（折合 USDT）', value: 20, price: 0.999 }])]),
    snap('2026-10-22', [binance(100, [usdt(60), { coin: 'USDT', account: '现货（折合 USDT）', value: 40, price: 0.999 }])]),
  ] }).days;
  assert.equal(day.sources.length, 1); assert.equal(day.sources[0].change, 0);
  assert.deepEqual(day.sources[0].details.map(item => item.change), [-20, 20]);
});

test('a stalled cycle summary is not mixed with fresh unrealized PnL', () => {
  const since = '2026-10-10T00:00:00.000Z';
  const previous = capture('2026-10-21T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '100', { since, net: '0' })]);
  const current = capture('2026-10-22T15:00:00.000Z', [leg('CLUSDT', 'long', '10', '50', { since, net: '0', updatedAt: '2026-10-22T14:30:00.000Z' })]);
  const [held] = legs(previous, current).positions;
  assert.equal(held.cashFlowChange, null); assert.equal(held.partial, true);
  const [day] = calculateDailyChanges({ ...base, snapshots: [snap('2026-10-21', [binance(1000)], { positions: previous }), snap('2026-10-22', [binance(1010)], { positions: current })] }).days;
  assert.equal(group(day.positions!, 'oil').complete, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDailyChanges, readDailyChanges, type ChangeSnapshot } from '../lib/daily-changes.ts';
import { openDatabase } from '../lib/sqlite.ts';

const row = (id: string, project: string, value: number | null, kind = '资产') => ({ id, project, kind, value });
const snap = (date: string, rows: ReturnType<typeof row>[], extra: Partial<ChangeSnapshot> = {}): ChangeSnapshot => ({
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

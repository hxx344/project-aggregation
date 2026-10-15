import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/sqlite.ts';
import { readSnapshotHistory } from '../lib/snapshot-history.ts';
import { assetTrend } from '../lib/withdrawals.ts';
import { calculateAnnualizedReturns, calculateMonthlyPerformance } from '../lib/performance-metrics.ts';
import type { Period } from '../lib/types.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const day = (index: number) => new Date(Date.UTC(2022, 0, 1 + index)).toISOString().slice(0, 10);
const period = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, date, total: 1000, fx: 7, cny: 7000, future: false, difference: 0,
  assets: [{ project: '持仓', value: 1000 }], ...extra,
});

test('all daily history survives more than 730 days and a full archive window', async t => {
  const database = openDatabase(':memory:', migrations);
  t.after(() => database.close());
  const insert = database.prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?)');
  const daily = Array.from({ length: 800 }, (_, index) => period(`daily-${day(index)}`, day(index), { total: 1000 + index }));
  const archives = Array.from({ length: 760 }, (_, index) => period(`archive-${index}`, day(index + 800), { archived: true }));
  await database.batch([
    ...daily.map(row => insert.bind('alice', row.date, JSON.stringify(row))),
    ...archives.map(row => insert.bind('alice', row.id, JSON.stringify(row))),
  ]);

  const history = await readSnapshotHistory(database, 'alice');
  assert.equal(history.length, 800 + 730);
  assert.deepEqual(history.filter(row => !row.archived).map(row => row.date), daily.map(row => row.date).reverse());
  assert.equal(history[0].date, archives.at(-1)?.date);
  assert.equal(history.at(-1)?.date, daily[0].date);
  assert.ok(history.every(row => !Object.hasOwn(row, 'assets')), 'history projection must omit asset detail payloads');

  const trend = assetTrend({ history, withdrawals: [], baselineDate: day(0) }, day(1600));
  assert.equal(trend.length, 800, 'archives must not displace valid performance points');
  assert.equal(trend[0].date, day(0));
  assert.equal(trend.at(-1)?.date, day(799));
  assert.equal(trend.at(-1)?.adjusted, 1799);
  const metrics = calculateAnnualizedReturns(trend, calculateMonthlyPerformance(trend), day(1600));
  assert.equal(metrics.daysSpan, 799, 'lifetime annualization must use the first stored day');
  // Two full ordinary years followed by 69 elapsed days of leap year 2024.
  assert.ok(Math.abs(metrics.overallAnnualized! - 0.799 / (2 + 69 / 366)) < 1e-10);
  const stored = await database.prepare('SELECT data FROM snapshots WHERE owner=? AND date=?').bind('alice', day(0)).first<{ data: string }>();
  assert.deepEqual(JSON.parse(stored!.data).assets, daily[0].assets, 'reading must preserve stored asset detail');
});

test('daily and archived snapshots remain isolated by owner with interleaved reads', async t => {
  const database = openDatabase(':memory:', migrations);
  t.after(() => database.close());
  const insert = database.prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?)');
  const date = day(0);
  await database.batch(['alice', 'bob'].flatMap((owner, index) => [
    insert.bind(owner, date, JSON.stringify(period(`daily-${date}`, date, { total: index + 1 }))),
    insert.bind(owner, 'archive-same-key', JSON.stringify(period('archive-same-key', day(1), { archived: true, total: index + 3 }))),
  ]));
  const [alice, bob, missing] = await Promise.all([
    readSnapshotHistory(database, 'alice'),
    readSnapshotHistory(database, 'bob'),
    readSnapshotHistory(database, 'missing'),
  ]);
  assert.deepEqual(alice.map(row => row.total), [3, 1]);
  assert.deepEqual(bob.map(row => row.total), [4, 2]);
  assert.deepEqual(missing, []);
});

test('legacy withdrawals are backfilled without asset payloads and explicit values take precedence', async t => {
  const database = openDatabase(':memory:', migrations);
  t.after(() => database.close());
  const assets = [
    { project: ' 出金 ', value: 120.25 },
    { project: '出金', value: 30.5 },
    { project: '出金', value: null },
    { project: '出借', value: 900 },
  ];
  const rows = [
    period('daily-legacy', day(0), { assets, partial: true }),
    period('archive-legacy', day(1), { assets, archived: true }),
    period('daily-zero', day(2), { assets, withdrawn: 0 }),
    period('daily-explicit', day(3), { assets, withdrawn: 42 }),
    period('daily-no-assets', day(4), { assets: undefined }),
  ];
  const insert = database.prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?)');
  await database.batch(rows.map(row => insert.bind('alice', row.id.startsWith('archive-') ? row.id : row.date, JSON.stringify(row))));

  const history = await readSnapshotHistory(database, 'alice');
  const expectedWithdrawn = [150.75, 150.75, 0, 42, 0];
  assert.deepEqual(history, rows.map((row, index) => {
    const { assets: omitted, ...snapshot } = row;
    void omitted;
    return { ...snapshot, withdrawn: expectedWithdrawn[index] } as Period;
  }).reverse());
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { assetMeasures, assetDisplayRows, assetTrend, embeddedWithdrawals, chinaDay, periodMeasures } from '../lib/withdrawals.ts';
import { withdrawalSchema } from '../lib/validation.ts';
import type { Asset, Period, Withdrawal } from '../lib/types.ts';

const withdrawal = (date: string, amount: number): Withdrawal => ({ id: crypto.randomUUID(), date, amount, note: '', createdAt: date, updatedAt: date });
const period = (id: string, date: string, total: number, withdrawn = 0): Period => ({ id, date, total, withdrawn, fx: 7, cny: total * 7, difference: 0, future: false });
const asset = (id: string, project: string, quantity: number | null, price: number | null = 1): Asset => ({
  id, project, quantity, price, value: quantity === null || price === null ? null : quantity * price,
  kind: '资产', mode: 'manual', cell: 'E2', updatedAt: '2026-09-14T00:00:00+08:00', status: '手动估值',
});

test('current details and total include recorded withdrawals once through add, edit, delete and refresh', () => {
  const assets = [asset('row-1', '持仓', 1000), asset('row-2', ' 出金 ', 200), asset('row-3', '出金', 50)];
  const original = structuredClone(assets);
  const records = [withdrawal('2026-09-18', 100.25), withdrawal('2026-09-20', 500)];
  const check = (expected: number) => {
    const rows = assetDisplayRows(assets, records, '2026-09-19');
    const measures = assetMeasures(1250, 250, records, '2026-09-19');
    assert.equal(rows[0].value, 1000);
    assert.equal(rows[1].quantity, 200 + expected);
    assert.equal(rows[1].value, 200 + expected);
    assert.equal(rows[2].value, 50);
    assert.equal(rows.reduce((sum, row) => sum + (row.value ?? 0), 0), measures.adjusted);
    assert.equal(embeddedWithdrawals(rows), measures.withdrawn);
    assert.equal(measures.held, 1000);
    assert.equal(measures.adjusted, 1250 + expected);
    assert.deepEqual(assets, original, 'display values must never be persisted or passed to the original row editor');
    return rows;
  };
  assert.deepEqual(check(100.25), check(100.25), 'refresh starts from unchanged stored rows');
  records[0].amount = 90.5;
  check(90.5);
  records.shift();
  check(0);
});

test('USD records use a separate row when original withdrawal quantities have another unit or lack a value', () => {
  for (const assets of [
    [asset('row-1', '持仓', 1000)],
    [asset('row-1', '出金', 20, 7)],
    [asset('row-1', '出金', null)],
    [{ ...asset('row-1', '出金', 20), value: 25 }],
  ]) {
    const copy = structuredClone(assets);
    const records = [withdrawal('2026-09-18', 100.25), withdrawal('2026-09-20', 500)];
    const rows = assetDisplayRows(assets, records, '2026-09-19');
    assert.equal(rows.length, assets.length + 1);
    assert.deepEqual(rows.slice(0, -1), assets);
    assert.equal(rows.at(-1)?.id, 'recorded-withdrawals');
    assert.equal(rows.at(-1)?.quantity, 100.25);
    assert.equal(rows.at(-1)?.price, 1);
    assert.equal(rows.at(-1)?.value, 100.25);
    assert.equal(rows.at(-1)?.updatedAt, records[0].updatedAt);
    assert.deepEqual(assets, copy);
    assert.deepEqual(assetDisplayRows(assets, [], '2026-09-19'), assets);
  }
});

test('only the first compatible manual withdrawal row receives recorded USD', () => {
  const assets = [asset('row-1', '出金', 20, 7), asset('row-2', '出金', 200), asset('row-3', '出金', 50)];
  const rows = assetDisplayRows(assets, [withdrawal('2026-09-18', 100)], '2026-09-19');
  assert.deepEqual(rows.map(row => row.quantity), [20, 300, 50]);
  assert.deepEqual(rows.map(row => row.value), [140, 300, 50]);
});

test('workbook cumulative withdrawals are removed from holdings and added back exactly once', () => {
  const embedded = embeddedWithdrawals([{ project: '出金', value: 2000 }, { project: '出借', value: 500 }, { project: '其他', value: 1000 }]);
  assert.equal(embedded, 2000);
  assert.deepEqual(assetMeasures(3500, embedded, [], '2026-09-19'), { held: 1500, withdrawn: 2000, adjusted: 3500, recorded: 0 });
  assert.equal(embeddedWithdrawals([{ project: '出金', value: null }]), 0);
});

test('a withdrawal reduces actual holdings but leaves the adjusted value unchanged', () => {
  const before = assetMeasures(12000, 2000, [], '2026-09-17');
  const rows = [withdrawal('2026-09-18', 1000), withdrawal('2026-09-20', 500)];
  const after = assetMeasures(11000, 2000, rows, '2026-09-19');
  assert.equal(before.held - after.held, 1000);
  assert.equal(before.adjusted, after.adjusted);
  assert.equal(after.withdrawn, 3000);
  assert.equal(assetMeasures(11000, 2000, rows, '2026-09-17').recorded, 0);
});

test('backdated corrections recalculate later points without mutating stored totals', () => {
  const history = [period('E1', '2026-09-14', 12000, 2000), period('daily-2026-09-18', '2026-09-18', 11000, 2000), period('daily-2026-09-19', '2026-09-19', 11100, 2000)];
  const copy = structuredClone(history);
  const ledger = { history, baselineDate: '2026-09-14', withdrawals: [withdrawal('2026-09-18', 1000)] };
  assert.deepEqual(assetTrend(ledger, '2026-09-19').map(p => p.adjusted), [12000, 12000, 12100]);
  ledger.withdrawals[0].amount = 900;
  assert.deepEqual(assetTrend(ledger, '2026-09-19').map(p => p.adjusted), [12000, 11900, 12000]);
  ledger.withdrawals = [];
  assert.deepEqual(assetTrend(ledger, '2026-09-19').map(p => p.adjusted), [12000, 11000, 11100]);
  assert.deepEqual(history, copy);
});

test('trend prefers daily snapshots, keeps last same-day source, and excludes future/archive points', () => {
  const ledger = { baselineDate: '2026-09-14', withdrawals: [], history: [
    period('B1', '2026-09-01', 1000), period('C1', '2026-09-01', 2000),
    period('daily-2026-09-14', '2026-09-14', 4000), period('E1', '2026-09-14', 3000),
    { ...period('F1', '2026-09-15', 9000), future: true },
    { ...period('archive-a', '2026-09-16', 8000), archived: true },
    period('daily-2026-09-20', '2026-09-20', 7000),
  ] };
  assert.deepEqual(assetTrend(ledger, '2026-09-19').map(p => p.total), [2000, 4000]);
  assert.deepEqual(assetTrend({ ...ledger, history: [] }, '2026-09-19'), []);
});

test('same-day new withdrawals apply to live daily values but not the original baseline', () => {
  const ledger = { baselineDate: '2026-09-19', withdrawals: [withdrawal('2026-09-19', 100)] };
  assert.equal(periodMeasures(period('E1', '2026-09-19', 1000), ledger).adjusted, 1000);
  assert.equal(periodMeasures(period('daily-2026-09-19', '2026-09-19', 900), ledger).adjusted, 1000);
});

test('withdrawal validation rejects invalid dates, precision and amounts; dates use Beijing midnight', () => {
  const input = { id: crypto.randomUUID(), date: '2026-09-19', amount: 12.34, note: ' test ' };
  assert.equal(withdrawalSchema.parse(input).note, 'test');
  for (const changes of [{ date: '2026-02-30' }, { amount: 0 }, { amount: -1 }, { amount: Infinity }, { amount: 0.001 }, { amount: 0.00001 }, { amount: 1e13 }, { id: 'row-1' }, { note: 'x'.repeat(201) }, { owner: 'someone-else' }]) {
    assert.equal(withdrawalSchema.safeParse({ ...input, ...changes }).success, false);
  }
  assert.equal(chinaDay(new Date('2026-09-18T15:59:59Z')), '2026-09-18');
  assert.equal(chinaDay(new Date('2026-09-18T16:00:00Z')), '2026-09-19');
});

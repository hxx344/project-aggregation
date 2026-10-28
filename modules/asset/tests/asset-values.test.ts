import test from 'node:test';
import assert from 'node:assert/strict';
import { knownAssetValue, knownWorkbookValue, sumKnownValues, sumWorkbookValues, snapshotValues, configuredExchanges, quantityValue, refreshMarketAsset, withMarketQuantity, workbookMissingValueSql } from '../lib/asset-values.ts';
import { openDatabase } from '../lib/sqlite.ts';
import type { Asset } from '../lib/types.ts';

const now = Date.parse('2026-10-23T04:00:00Z');
const fresh = new Date(now - 1000).toISOString();
const asset = (value: number | null, mode: Asset['mode'] = 'manual'): Asset => ({
  id: 'row-1', project: 'asset', kind: '资产', quantity: value, price: 1, value,
  mode, updatedAt: fresh, status: '手动估值', cell: 'E1',
});

test('unknown manual or fresh dynamic values make a snapshot partial while keeping the known subtotal', () => {
  for (const mode of ['manual', 'market', 'bybit'] as const) {
    const assets = [asset(125.5), asset(null, mode), asset(0)];
    const original = structuredClone(assets);
    assert.deepEqual(snapshotValues(assets, { error: null }, now), { total: 125.5, missingValues: 1, partial: true });
    assert.deepEqual(assets, original);
    assert.equal(assets[1].value, null, 'unknown asset values must remain unknown');
  }
});

test('an entirely unknown subtotal is explicitly partial; a genuine zero subtotal is complete', () => {
  assert.deepEqual(sumKnownValues([asset(null), asset(null)]), { total: 0, missingValues: 2, partial: true });
  assert.deepEqual(snapshotValues([asset(0), asset(0, 'market')], { error: null }, now), { total: 0, missingValues: 0, partial: false });
  assert.deepEqual(sumKnownValues([]), { total: 0, missingValues: 0, partial: false });
});

test('legacy market null-quantity zeros are unknown without reclassifying genuine or independent valuations', () => {
  const legacy = { ...asset(0, 'market'), quantity: null, price: 2.5 };
  const original = structuredClone(legacy);
  assert.equal(knownAssetValue(legacy), null);
  assert.deepEqual(snapshotValues([asset(100), legacy], { error: null }, now), { total: 100, missingValues: 1, partial: true });
  assert.deepEqual(legacy, original, 'reading must not rewrite old rows');
  for (const row of [
    { ...legacy, quantity: 0 }, { ...legacy, mode: 'manual' }, { ...legacy, mode: 'bybit' },
    { value: 0, mode: 'market' }, { ...legacy, value: 25 },
  ]) assert.equal(knownAssetValue(row), row.value, 'only the determinable legacy market state is reclassified');
  assert.deepEqual(snapshotValues([{ ...legacy, quantity: 0 }], { error: null }, now), { total: 0, missingValues: 0, partial: false });
});

test('snapshot completeness still includes FX failures, asset errors and source freshness', () => {
  assert.equal(snapshotValues([asset(10)], { error: '汇率失败' }, now).partial, true);
  for (const row of [
    { ...asset(10, 'market'), error: '行情失败' },
    { ...asset(10, 'market'), updatedAt: new Date(now - 900_001).toISOString() },
    { ...asset(10, 'market'), updatedAt: '' },
  ]) assert.equal(snapshotValues([row], { error: null }, now).partial, true);
  assert.equal(snapshotValues([{ ...asset(10), updatedAt: '2020-01-01' }], { error: null }, now).partial, false);
});

test('unconnected exchange rows keep their valuation without making a snapshot partial; configured failures still do', () => {
  const old = '2026-09-21T00:00:00+08:00';
  for (const mode of ['bybit', 'aster', 'binance', 'okx', 'gate', 'variational'] as const) {
    const placeholder = { ...asset(100, mode), updatedAt: old, status: '待连接 · 表格值' };
    const disconnected = { ...placeholder, status: '已断开 · 保留旧值', error: 'Previous sync failed' };
    const rows = [placeholder, { ...asset(5), id: 'row-2' }];
    assert.deepEqual(snapshotValues(rows, { error: null }, now, []), { total: 105, missingValues: 0, partial: false }, mode);
    assert.equal(snapshotValues([disconnected], { error: null }, now, ['market']).partial, false, mode);
    assert.equal(snapshotValues(rows, { error: null }, now).partial, true, 'missing connection context stays conservative');
    assert.equal(snapshotValues(rows, { error: null }, now, [mode]).partial, true, 'a configured exchange must still refresh');
    assert.equal(snapshotValues([{ ...asset(100, mode), error: 'read failed' }], { error: null }, now, [mode]).partial, true, 'a configured read failure is partial');
    assert.deepEqual(snapshotValues([{ ...placeholder, value: null }], { error: null }, now, []), { total: 0, missingValues: 1, partial: true }, 'an unknown retained value is still missing');
  }
  assert.equal(snapshotValues([{ ...asset(10, 'market'), updatedAt: old }], { error: null }, now, []).partial, true, 'market quotes are never retained');
  assert.equal(snapshotValues([asset(10)], { error: 'FX failed' }, now, []).partial, true);
});

test('configured exchanges follow saved connections, including any configured Aster account', () => {
  const connection = (configured: boolean) => ({ configured, lastSync: null, error: null, scope: '' });
  assert.deepEqual(configuredExchanges({
    bybit: connection(false), aster: connection(true), binance: connection(false), okx: connection(true), gate: connection(false), variational: connection(false),
  }), ['aster', 'okx']);
});

test('non-finite values are missing rather than poisoning a known subtotal', () => {
  assert.deepEqual(sumKnownValues([asset(10), asset(NaN), asset(Infinity)]), { total: 10, missingValues: 2, partial: true });
});

test('a successful quote refresh never turns an unknown quantity into a zero valuation or a success state', () => {
  const original = { ...asset(null, 'market'), error: '数量未知' };
  const quote = { price: 2.5, at: fresh, source: '行情源' };
  const refreshed = refreshMarketAsset(original, quote);
  assert.equal(refreshed.quantity, null);
  assert.equal(refreshed.value, null);
  assert.equal(refreshed.price, 2.5);
  assert.equal(refreshed.updatedAt, fresh);
  assert.match(refreshed.error!, /数量未知/);
  assert.match(refreshed.status, /数量待填写/);
  assert.equal(snapshotValues([refreshed], { error: null }, now).partial, true);
  assert.equal(original.error, '数量未知');
});

test('a quote refresh preserves genuine zero quantities and clears a resolved quote error', () => {
  for (const quantity of [0, 4]) {
    const refreshed = refreshMarketAsset({ ...asset(quantity, 'market'), error: '行情失败' }, { price: 2.5, at: fresh, source: '行情源' });
    assert.equal(refreshed.value, quantity * 2.5);
    assert.equal(refreshed.error, undefined);
    assert.equal(snapshotValues([refreshed], { error: null }, now).partial, false);
  }
});

test('reusing a saved quote during import keeps unknown inputs distinct from real zero values', () => {
  assert.equal(quantityValue(null, 2.5), null);
  assert.equal(quantityValue(4, null), null);
  assert.equal(quantityValue(0, 2.5), 0);
  assert.equal(quantityValue(4, 0), 0);
  assert.equal(quantityValue(4, 2.5), 10);
});

test('filling a market quantity resolves the unknown state immediately without clearing independent quote failures', () => {
  const quote = { price: 2.5, at: fresh, source: '行情源' };
  const unknown = refreshMarketAsset(asset(null, 'market'), quote);
  const zero = withMarketQuantity(unknown, 0);
  assert.equal(zero.value, 0);
  assert.equal(zero.error, undefined);
  assert.doesNotMatch(zero.status, /数量待填写/);
  assert.equal(snapshotValues([zero], { error: null }, now).partial, false);
  const failed = withMarketQuantity({ ...unknown, error: '行情失败' }, 4);
  assert.equal(failed.error, '行情失败');
  assert.equal(failed.updatedAt, unknown.updatedAt, 'editing a quantity must not freshen its quote');
});
test('blank workbook cells are known zeros while uncached formulas and partial inputs stay unknown', () => {
  const blank = { value: null, quantity: null, price: null, formula: null };
  assert.equal(knownWorkbookValue(blank), 0);
  assert.equal(knownWorkbookValue({ value: null }), 0, 'absent fields are blank too');
  for (const row of [{ ...blank, formula: '=B2*C2' }, { ...blank, quantity: 3 }, { ...blank, price: 2.5 }, { ...blank, value: NaN }]) {
    assert.equal(knownWorkbookValue(row), null);
  }
  assert.equal(knownWorkbookValue({ ...blank, value: 12, formula: '=B2*C2' }), 12);
  assert.deepEqual(sumWorkbookValues([{ ...blank, value: 50 }, blank, { ...blank, formula: '=X1' }]), { total: 50, missingValues: 1, partial: true });
  assert.deepEqual(sumWorkbookValues([{ ...blank, value: 50 }, blank]), { total: 50, missingValues: 0, partial: false });
});

test('workbook SQL classifies the same rows as knownWorkbookValue', async t => {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const rows = [
    { value: null, quantity: null, price: null, formula: null }, { value: null }, {},
    { value: null, formula: '=B2*C2' }, { value: null, quantity: 3 }, { value: null, price: 2.5 },
    { value: 0 }, { value: 7, formula: '=B2*C2' }, { value: 0, quantity: null, mode: 'market' },
  ];
  const result = await database.prepare(`SELECT ${workbookMissingValueSql('a.value')} AS missing FROM json_each(?) a ORDER BY CAST(a.key AS INTEGER)`).bind(JSON.stringify(rows)).all<{ missing: number }>();
  assert.deepEqual(result.results.map(row => !!row.missing), rows.map(row => knownWorkbookValue(row as Parameters<typeof knownWorkbookValue>[0]) === null));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Asset } from '../lib/types.ts';

// Same hooks as store-sync-lock.test.ts: the real lib/store.ts with external effects swapped for fixtures/store-fakes.ts.
const fakes = new URL('./fixtures/store-fakes.ts', import.meta.url).href;
const faked = new Set(['./exchanges', './okx', './gate', './variational', './fx', './vault', './hub-positions', './sqlite']);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/lib/store.ts') && faked.has(specifier)) return { url: fakes, shortCircuit: true };
    if (specifier.startsWith('./') && !/\.\w+$/.test(specifier)) return nextResolve(specifier + '.ts', context);
    if (specifier.endsWith('.json')) return { ...nextResolve(specifier, context), importAttributes: { type: 'json' } };
    return nextResolve(specifier, context);
  },
});
const dataDir = mkdtempSync(join(tmpdir(), 'asset-aero-lp-'));
process.env.ASSET_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
const store = await import('../lib/store.ts');
const { control } = await import('./fixtures/store-fakes.ts');
const { parseAeroLp, planAeroLp, INVALID_AERO_LP } = await import('../lib/aero-lp.ts');

const WALLET = '0x' + 'ab'.repeat(20);
const valuation = (total: number | null, at: string | null, extra = {}) => ({
  wallet: WALLET, state: 'running', at, total, error: null,
  details: total === null ? [] : [{ account: '头寸 #7（质押）', coin: 'USDC', quantity: total, value: total }], ...extra,
});
const usdc = (price: number, at = '2026-10-30T02:00:00.000Z') => ({ price, at, source: 'test' });
const row = (extra: Partial<Asset> = {}): Asset => ({ id: 'row-3', project: 'Aero LP', kind: '链上 LP', quantity: 500, price: 1, value: 500, cell: 'E3', mode: 'aero', updatedAt: '2026-10-30T01:00:00.000Z', status: '工作台同步 · 链上估值时间', ...extra });
const others: Asset[] = [{ id: 'row-1', project: 'virtual', kind: '代币', quantity: 1, price: 1, value: 1, cell: 'E1', mode: 'market', updatedAt: '', status: '' }];

test('the workbench valuation is converted with the USDC quote and dated by the older source', () => {
  const plan = planAeroLp(others, valuation(1000, '2026-10-30T02:00:30.000Z'), usdc(0.998), undefined, Date.parse('2026-10-30T02:01:00Z'));
  assert.equal(plan.type, 'save');
  if (plan.type !== 'save') return;
  assert.equal(plan.asset.id, 'row-2');
  assert.equal(plan.asset.mode, 'aero');
  assert.equal(plan.asset.quantity, 1000);
  assert.equal(plan.asset.value, 998);
  assert.equal(plan.asset.details?.[0].value, 998);
  assert.equal(plan.asset.updatedAt, '2026-10-30T02:00:00.000Z');
  assert.match(plan.asset.kind, /0xabab…abab$/);
});

test('a failed valuation keeps the previous value and never creates a row', () => {
  const cases: [Parameters<typeof planAeroLp>[1], ReturnType<typeof usdc> | undefined, string][] = [
    [valuation(null, null, { error: 'Aero LP 未运行，尚无链上估值' }), usdc(1), 'Aero LP 未运行，尚无链上估值'],
    [valuation(1000, '2026-10-30T02:00:00.000Z'), undefined, '行情失败'],
    [valuation(1000, '2026-10-30T02:00:00.000Z'), usdc(0), '行情失败'],
    ['invalid', usdc(1), INVALID_AERO_LP],
  ];
  for (const [input, quote, error] of cases) {
    assert.deepEqual(planAeroLp([...others, row()], input, quote, '行情失败'), { type: 'save', asset: { ...row(), status: '同步失败 · 保留旧值', error } });
    assert.deepEqual(planAeroLp(others, input, quote, '行情失败'), { type: 'none' });
  }
});

test('no configured wallet removes the row; a missing field leaves everything alone', () => {
  assert.deepEqual(planAeroLp([...others, row()], null, usdc(1), undefined), { type: 'delete', id: 'row-3' });
  assert.deepEqual(planAeroLp(others, null, usdc(1), undefined), { type: 'none' });
  assert.equal(parseAeroLp({}), undefined);
  assert.equal(parseAeroLp({ aeroLp: null }), null);
  assert.equal(parseAeroLp({ aeroLp: { ...valuation(1, null), total: 'NaN' } }), 'invalid');
  assert.equal(parseAeroLp({ aeroLp: { ...valuation(1, null), extra: true } }), 'invalid');
});

test('refresh applies a valuation that arrived while throttled on the next unthrottled refresh', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T02:00:00Z') });
  control.usdc = 0.998;
  const owner = 'aero-owner', aero = (ledger: { assets: Asset[] }) => ledger.assets.find(asset => asset.mode === 'aero');
  let ledger = await store.refresh(owner, valuation(1000, '2026-10-30T01:59:50.000Z'));
  assert.equal(aero(ledger)?.value, 998);
  assert.equal(ledger.history.at(-1)?.total, ledger.assets.reduce((sum, asset) => sum + (asset.value ?? 0), 0));

  t.mock.timers.tick(10_000);
  ledger = await store.refresh(owner, valuation(2000, '2026-10-30T02:00:05.000Z'));
  assert.equal(aero(ledger)?.value, 998, 'throttled refresh only stores the input');
  t.mock.timers.tick(31_000);
  ledger = await store.refresh(owner);
  assert.equal(aero(ledger)?.value, 1996);
  assert.equal(aero(ledger)?.updatedAt, '2026-10-30T02:00:05.000Z');

  await assert.rejects(store.editAsset(owner, { id: aero(ledger)!.id, quantity: 1, price: 1 }), /工作台同步维护/);

  t.mock.timers.tick(31_000);
  ledger = await store.refresh(owner, valuation(null, null, { error: 'Aero LP 本轮头寸估值读取失败' }));
  assert.equal(aero(ledger)?.value, 1996);
  assert.equal(aero(ledger)?.error, 'Aero LP 本轮头寸估值读取失败');

  t.mock.timers.tick(31_000);
  ledger = await store.refresh(owner, null);
  assert.equal(aero(ledger), undefined);
});

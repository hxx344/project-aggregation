import test from 'node:test';
import assert from 'node:assert/strict';
import { add, divide, multiply, summarizeCycle, type CycleFill } from '../lib/positions-cycle.ts';
import { parseCycleEvidence } from '../lib/cycle-evidence.ts';
const at = Date.parse('2026-11-10T00:00:00Z');
const fill = (id: string, side: 'buy' | 'sell', quantity: string, fee = '-1'): CycleFill => ({ id, time: at - 10_000, side, quantity, price: '100', realizedPnl: '5', fee, feeCurrency: 'USD' });
const base = { current: '2', currency: 'USD', complete: true, openingFraction: '0.6', since: at - 10_000, fundingAttributable: true, notes: [], updatedAt: new Date(at).toISOString() };

test('flip evidence reconciles with cycle totals, excludes old flows, and keeps exact fractions', () => {
  const cycle = summarizeCycle({ ...base, fills: [fill('close', 'sell', '1', '-0.1'), fill('flip', 'buy', '5')],
    cash: [{ id: 'funding', time: at - 5000, kind: 'funding', amount: '-0.2', currency: 'USD' }, { id: 'old', time: at - 20_000, kind: 'funding', amount: '999', currency: 'USD' }],
    excludedFills: [fill('prior', 'sell', '2')] });
  const evidence = parseCycleEvidence(cycle.evidence)!;
  assert.equal(evidence.rows[0].quantity, '3'); assert.equal(evidence.rows[0].realizedPnl, null); assert.equal(evidence.rows[0].fee, '-0.6');
  assert.equal(evidence.rows[0].side, 'buy'); assert.equal(evidence.rows[0].closingQuantity, '0');
  const closed = evidence.rows.reduce((sum, row) => add(sum, row.closingQuantity ?? '0'), '0');
  const closedValue = evidence.rows.reduce((sum, row) => add(sum, row.closingQuantity && row.price ? multiply(row.closingQuantity, row.price) : '0'), '0');
  assert.equal(closed, cycle.closedQuantity); assert.equal(divide(closedValue, closed, 10), cycle.closePrice);
  assert.equal(evidence.rows.reduce((sum, row) => add(sum, row.fee ?? '0'), '0'), cycle.fees);
  assert.equal(evidence.rows.reduce((sum, row) => add(sum, row.realizedPnl ?? '0'), '0'), cycle.realizedPnl);
  assert.equal(evidence.rows.filter(row => row.kind === 'funding').reduce((sum, row) => add(sum, row.amount ?? '0'), '0'), cycle.funding);
  assert.equal(evidence.rows.find(row => row.id === 'old')!.status, 'excluded'); assert.equal(evidence.rows.find(row => row.id === 'prior')!.status, 'excluded');
  const stripped = parseCycleEvidence({ ...evidence, accountIdentity: 'secret', rows: evidence.rows.map(row => ({ ...row, apiKey: 'secret' })) });
  assert.doesNotMatch(JSON.stringify(stripped), /secret/);
  assert.equal(parseCycleEvidence({ ...evidence, rows: Array(201).fill(evidence.rows[0]) }), null);
  const legacy = parseCycleEvidence({ ...evidence, rows: evidence.rows.map(({ side: _side, closingQuantity: _closing, ...row }) => row) });
  assert.equal(legacy!.rows[0].closingQuantity, undefined, 'old evidence does not become zero-close proof');
});

test('bounded evidence explicitly discloses truncation while summary uses all fills', () => {
  const fills = Array.from({ length: 205 }, (_, index) => fill(String(index), 'buy', '1'));
  const cycle = summarizeCycle({ ...base, current: '205', openingFraction: null, fills, cash: [] });
  assert.equal(cycle.fees, '-205'); assert.equal(cycle.evidence!.rows.length, 200); assert.equal(cycle.evidence!.totalRows, 205); assert.equal(cycle.evidence!.truncated, true);
});

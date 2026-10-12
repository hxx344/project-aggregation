import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSource } from '../lib/source-ledger.ts';
const example = () => JSON.parse(readFileSync(new URL('../lib/example-ledger.json', import.meta.url), 'utf8'));
test('import validates baseline totals and recalculates future/difference flags', () => {
  const input = example();
  input.periods[0].future = true;
  input.periods[0].difference = 9000;
  const parsed = parseSource(input);
  assert.equal(parsed.periods[0].future, false);
  assert.equal(parsed.periods[0].difference, 0);
  input.periods[0].rows[0].value += 1;
  assert.throws(() => parseSource(input), /合计/);
});
test('import rejects invalid dates, duplicate IDs, missing exchange and mismatched baseline', () => {
  for (const mutate of [
    (input: ReturnType<typeof example>) => { input.startedAt = '2026-02-30'; },
    (input: ReturnType<typeof example>) => { input.periods.push(structuredClone(input.periods[0])); },
    (input: ReturnType<typeof example>) => { input.periods[0].rows[1].id = input.periods[0].rows[0].id; },
    (input: ReturnType<typeof example>) => { input.periods[0].rows[1].project = 'unknown'; },
    (input: ReturnType<typeof example>) => { input.baselineId = 'H1'; },
  ]) { const input = example(); mutate(input); assert.throws(() => parseSource(input)); }
});
test('import retains same-date archives and original historical differences, with inert formula text', () => {
  const input = example();
  const earlier = structuredClone(input.periods[0]);
  earlier.id = 'B1'; earlier.total = 1; earlier.rows[0].formula = '=DO_NOT_EXECUTE()';
  input.periods.unshift(earlier);
  const parsed = parseSource(input);
  assert.equal(parsed.periods.length, 2);
  assert.equal(parsed.periods[0].difference, 3609);
  assert.equal(parsed.periods[0].rows[0].formula, '=DO_NOT_EXECUTE()');
});

test('Binance is optional in imported workbooks and duplicate Binance rows are rejected', () => {
  const input=example();
  input.periods[0].rows.push({id:'row-7',project:'Binance',kind:'资产',quantity:0,price:1,value:0,cell:'E7'});
  assert.equal(parseSource(input).periods[0].rows.length,6);
  input.periods[0].rows.push({id:'row-8',project:' binance ',kind:'资产',quantity:0,price:1,value:0,cell:'E8'});
  assert.throws(()=>parseSource(input),/Binance/);
});

test('OKX is optional in imported workbooks and duplicate OKX rows are rejected', () => {
  const input=example();
  input.periods[0].rows.push({id:'row-7',project:'OKX',kind:'资产',quantity:0,price:1,value:0,cell:'E7'});
  assert.equal(parseSource(input).periods[0].rows.length,6);
  input.periods[0].rows.push({id:'row-8',project:' okx ',kind:'资产',quantity:0,price:1,value:0,cell:'E8'});
  assert.throws(()=>parseSource(input),/OKX/);
});

test('Var and Variational aliases identify the same optional account', () => {
  const input=example();
  input.periods[0].rows.push({id:'row-7',project:' Var ',kind:'资产',quantity:0,price:1,value:0,cell:'E7'});
  assert.equal(parseSource(input).periods[0].rows.length,6);
  input.periods[0].rows.push({id:'row-8',project:'VARIATIONAL',kind:'资产',quantity:0,price:1,value:0,cell:'E8'});
  assert.throws(()=>parseSource(input),/Var/);
});

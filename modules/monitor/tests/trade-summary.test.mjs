import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTradeEvents } from '../lib/trade-summary.ts';
import { oilTradeEvents, hynixTradeEvents, hynixTradeMarkers } from '../lib/hynix-trades.ts';
import { fill } from './oil-trades-fixtures.mjs';

const at = Date.parse('2026-11-01T08:00:00Z');
function batch(id, hours, quantity, left, right, close = false, extra = {}, before = close ? quantity : '0') {
  const time = new Date(at + hours * 3_600_000).toISOString();
  const after = String(Number(before) + (close ? -1 : 1) * Number(quantity));
  return [
    fill({ key: `${id}-cl`, time, quantity, price: right, side: close ? 'sell' : 'buy', positionBefore: before, positionAfter: after, ...extra }),
    fill({ key: `${id}-bz`, time, quantity, price: left, symbol: 'BZUSDT', base: 'BZ', quantityUnit: 'BZ', side: close ? 'buy' : 'sell', positionBefore: String(-Number(before)), positionAfter: String(-Number(after)), ...extra }),
  ];
}
test('same-day continuous entry and exit segments use quantity weighting, not mean event spreads', () => {
  const items = [...batch('a', 0, '1', '110', '100'), ...batch('b', 1, '3', '130', '105', false, {}, '1'), ...batch('c', 2, '2', '120', '110', true, {}, '4'), ...batch('d', 3, '1', '100', '95', true, {}, '2')];
  const events = oilTradeEvents(items), before = JSON.stringify(events);
  const [entry, exit] = summarizeTradeEvents(events, 'oil');
  assert.deepEqual([entry.eventCount, entry.fillCount, exit.eventCount, exit.fillCount], [2, 4, 2, 4]);
  assert.equal(entry.groups[0].spread, 21.25);
  assert.deepEqual(entry.groups[0].legs.map(leg => [leg.base, leg.quantity, leg.price]), [['BZ', '4', '125'], ['CL', '4', '103.75']]);
  assert.ok(Math.abs(exit.groups[0].spread - 25 / 3) < 1e-10);
  assert.equal(exit.groups[0].direction, entry.groups[0].direction, 'closing sides retain the original spread direction');
  assert.equal(entry.start, at); assert.equal(entry.end, at + 3_600_000);
  assert.equal(JSON.stringify(events), before, 'summary does not alter chart events');
});
test('accounts, sources, exchanges, scope, currency and opposite spread directions stay separate', () => {
  const originals = batch('a', 0, '1', '110', '100');
  for (const field of ['sourceId', 'exchangeId', 'accountId', 'scope', 'priceCurrency']) {
    const changed = originals.map(item => ({ ...item, key: `${item.key}-other`, [field]: field === 'priceCurrency' ? 'USDC' : 'other' }));
    assert.equal(summarizeTradeEvents(oilTradeEvents([...originals, ...changed]), 'oil')[0].groups.length, 2, field);
  }
  const reversed = originals.map(item => ({ ...item, key: `${item.key}-reverse`, side: item.side === 'buy' ? 'sell' : 'buy', positionAfter: item.side === 'buy' ? '-1' : '1' }));
  const [summary] = summarizeTradeEvents(oilTradeEvents([...originals, ...reversed]), 'oil');
  assert.equal(summary.groups.length, 2); assert.notEqual(summary.groups[0].direction, summary.groups[1].direction);
  assert.ok(summary.groups.every(group => group.legs.every(leg => leg.quantity === '1')));
});
test('native contract, position side and unit collisions cannot form an aggregate price pair', () => {
  const items = batch('a', 0, '1', '110', '100');
  for (const [field, value] of [['symbol', 'CLPERP'], ['positionSide', 'long'], ['quantityUnit', '张']]) {
    const [summary] = summarizeTradeEvents(oilTradeEvents([...items, { ...items[0], key: field, [field]: value }]), 'oil');
    assert.equal(summary.groups[0].legs.length, 3, field); assert.equal(summary.groups[0].spread, null, field);
  }
  const [single] = summarizeTradeEvents(oilTradeEvents([items[0]]), 'oil');
  assert.equal(single.groups[0].spread, null);
});
test('unknown and rebalancing events are not assigned to entry or exit; stale data stays marked', () => {
  assert.deepEqual(summarizeTradeEvents(oilTradeEvents([fill({ positionBefore: null, positionAfter: null })]), 'oil'), []);
  assert.deepEqual(summarizeTradeEvents(oilTradeEvents([fill({ positionBefore: '-1', positionAfter: '1' })]), 'oil'), []);
  const [summary] = summarizeTradeEvents(oilTradeEvents(batch('a', 0, '1', '110', '100', false, { stale: true })), 'oil');
  assert.equal(summary.groups[0].stale, true);
  assert.deepEqual(summarizeTradeEvents([], 'oil'), []);
});
test('Hynix uses the 10:1 conversion and only events visible in the selected chart interval', () => {
  const items = [...batch('a', 0, '1', '42', '400'), ...batch('b', 1, '3', '46', '400', false, {}, '1')].map(item => ({ ...item,
    symbol: item.base === 'BZ' ? 'SKHYUSDT' : 'SKHYNIXUSDT', quantityUnit: item.base === 'BZ' ? 'SKHY' : 'SKHYNIX', base: item.base === 'BZ' ? 'SKHY' : 'SKHYNIX',
  }));
  const events = hynixTradeEvents(items);
  const [all] = summarizeTradeEvents(events, 'hynix');
  assert.ok(Math.abs(all.groups[0].spread - 12.5) < 1e-9);
  const markers = hynixTradeMarkers(events, [{ time: at + 3_600_000, adr: 46, ordinary: 400, equivalent: 40, spread: 6, premium: 15 }]);
  const [visible] = summarizeTradeEvents(markers.map(marker => marker.event), 'hynix');
  assert.equal(visible.fillCount, 2); assert.ok(Math.abs(visible.groups[0].spread - 15) < 1e-9);
});

test('separate Beijing dates, reconstructed position gaps, and intervening operations never merge', () => {
  const a = batch('a', 0, '1', '110', '100');
  const b = batch('b', 2, '1', '110', '100', false, {}, '1');
  const nextDay = batch('day2', 24, '1', '110', '100', false, {}, '1');
  assert.equal(summarizeTradeEvents(oilTradeEvents([...a, ...nextDay]), 'oil').length, 2);
  assert.equal(summarizeTradeEvents(oilTradeEvents([...a, ...batch('restart', 2, '1', '110', '100')]), 'oil').length, 2, 'a new opening from zero starts another segment');
  for (const middle of [batch('close', 1, '1', '110', '100', true),
    [fill({ key: 'unknown', time: new Date(at + 3_600_000).toISOString(), positionBefore: null, positionAfter: null })],
    [fill({ key: 'rebalance', time: new Date(at + 3_600_000).toISOString(), positionBefore: '-1', positionAfter: '1' })]]) {
    const summaries = summarizeTradeEvents(oilTradeEvents([...a, ...middle, ...b]), 'oil');
    assert.equal(summaries.filter(summary => summary.type === 'entry').length, 2, 'other operation interrupts the consecutive segment');
  }
  const changedAccount = batch('other', 2, '1', '110', '100', false, { accountId: 'other' }, '1');
  assert.equal(summarizeTradeEvents(oilTradeEvents([...a, ...changedAccount]), 'oil').length, 2);
});

test('a ten-minute event is split at Beijing midnight, including within the same UTC date', () => {
  const before = batch('before', 0, '1', '110', '100').map(item => ({ ...item, time: '2026-11-01T15:59:00.000Z' }));
  const after = batch('after', 0, '1', '120', '100', false, {}, '1').map(item => ({ ...item, time: '2026-11-01T16:01:00.000Z' }));
  const events = oilTradeEvents([...before, ...after]);
  assert.equal(events.length, 2);
  const summaries = summarizeTradeEvents(events, 'oil');
  assert.equal(summaries.length, 2); assert.deepEqual(summaries.map(item => item.fillCount), [2, 2]);
});

test('a final close joins preceding reductions and only then ends the position segment', () => {
  const events = oilTradeEvents([...batch('a', 0, '2', '110', '100', true, {}, '4'), ...batch('b', 1, '1', '110', '100', true, {}, '2'), ...batch('c', 2, '1', '110', '100', true)]);
  const [summary] = summarizeTradeEvents(events, 'oil');
  assert.equal(summary.eventCount, 3); assert.equal(summary.fillCount, 6); assert.equal(summary.groups[0].legs[0].quantity, '4');
});

test('same-millisecond fill chains use exact reconstructed positions rather than lexicographic IDs', () => {
  const sameTime = new Date(at).toISOString();
  const rows = [
    fill({ key: '9', time: sameTime, quantity: '1.000000000000000001', positionBefore: '0', positionAfter: '1.000000000000000001' }),
    fill({ key: '10', time: sameTime, quantity: '1', positionBefore: '1.000000000000000001', positionAfter: '2.000000000000000001' }),
    fill({ key: '11', time: new Date(at + 3_600_000).toISOString(), quantity: '1', positionBefore: '2.0000000000000000010', positionAfter: '3.000000000000000001' }),
  ];
  const [summary] = summarizeTradeEvents(oilTradeEvents(rows), 'oil');
  assert.equal(summary.eventCount, 2); assert.equal(summary.groups[0].legs[0].quantity, '3.000000000000000001');
  const broken = rows.map(row => row.key === '10' ? { ...row, positionBefore: '5', positionAfter: '6' } : row);
  assert.equal(summarizeTradeEvents(oilTradeEvents(broken), 'oil').length, 2, 'internal discontinuities cannot establish a continuous segment');
});

test('a new native position or mixed spread directions cannot borrow another leg continuity', () => {
  const a = batch('a', 0, '1', '110', '100'), b = batch('b', 1, '1', '110', '100', false, {}, '1');
  const newContract = { ...b[0], key: 'new-contract', symbol: 'CLPERP', positionBefore: '0', positionAfter: '1' };
  assert.equal(summarizeTradeEvents(oilTradeEvents([...a, ...b, newContract]), 'oil').length, 2);
  const mixed = [...a, { ...a[0], key: 'reverse', side: 'sell', positionBefore: '0', positionAfter: '-1' }, ...b];
  assert.equal(summarizeTradeEvents(oilTradeEvents(mixed), 'oil').length, 2);
});

test('opening, closing and reopening within ten minutes remain independent operations', () => {
  const events = oilTradeEvents([
    fill({ key: 'open', time: new Date(at).toISOString(), quantity: '1', positionBefore: '0', positionAfter: '1' }),
    fill({ key: 'close', time: new Date(at + 120_000).toISOString(), side: 'sell', quantity: '1', positionBefore: '1', positionAfter: '0' }),
    fill({ key: 'reopen', time: new Date(at + 240_000).toISOString(), quantity: '1', positionBefore: '0', positionAfter: '1' }),
  ]);
  assert.deepEqual(events.map(event => event.type), ['entry', 'exit', 'entry']);
  assert.deepEqual(summarizeTradeEvents(events, 'oil').map(summary => [summary.type, summary.fillCount]), [['entry', 1], ['exit', 1], ['entry', 1]]);
});
